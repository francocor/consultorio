import type { SubscriptionUsageResponse } from '@consultorio/contracts';
import { allocateProportional, money } from '@consultorio/contracts';
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { message } from '../../../db/schema/notifications.js';
import { professional } from '../../../db/schema/staff.js';
import {
  usageRecord,
  type PlanRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import { whatsappUsageEvent } from '../../../db/schema/usage-event.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import {
  dayOf,
  daysLeftIncludingToday,
  periodBounds,
  periodOf,
  previousPeriod,
} from '../domain/periods.js';

import type { SubscriptionDeps } from './provider.js';
import { CURRENT_TENANT } from './store.js';

/**
 * What the subscription meters: the days each professional was active, and the WhatsApp messages the
 * provider accepted for each one. Counts only (no message, no patient). The count of messages is the
 * one of `whatsapp_usage_event`, which the notifications module writes; this module reads it, rolls
 * it up per professional and period, and prices it.
 */

// The snapshot ---------------------------------------------------------------------------------------

/** The professionals active now: the definition of `domain/active-professional.ts`, as a query. */
async function activeProfessionalIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: professional.id })
    .from(professional)
    .innerJoin(
      membership,
      and(
        eq(membership.tenantId, professional.tenantId),
        eq(membership.id, professional.membershipId),
      ),
    )
    .where(
      and(
        eq(membership.status, 'active'),
        sql`'professional' = any(${membership.roles})`,
        eq(professional.status, 'active'),
      ),
    )
    .orderBy(asc(professional.id));
  return rows.map((row) => row.id);
}

/**
 * `usage.snapshot`: writes today's day of activity for each active professional (once per professional
 * and day, however many times it runs) and the monthly count of accepted messages for the current and
 * the previous period. Safe to run at any time and any number of times. It reads no provider and holds
 * no connection while it waits for anything.
 */
export async function runUsageSnapshot(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<{ days: number; months: number }> {
  return deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [org] = await tx
      .select({ isDemo: tenant.isDemo, status: tenant.status })
      .from(tenant)
      .where(eq(tenant.id, CURRENT_TENANT));
    // A demo has nobody to bill or meter, and a cancelled organization is no longer metered.
    if (!org || org.isDemo || org.status === 'cancelled') return { days: 0, months: 0 };

    const now = deps.clock();
    const day = dayOf(now);
    const period = periodOf(now);

    const ids = await activeProfessionalIds(tx);
    let days = 0;
    if (ids.length > 0) {
      const inserted = await tx
        .insert(usageRecord)
        .values(
          ids.map((professionalId) => ({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            kind: 'active_professional_day',
            professionalId,
            period,
            day,
            quantity: 1,
            recordedAt: now,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: usageRecord.id });
      days = inserted.length;
    }

    let months = 0;
    for (const target of [period, previousPeriod(period)]) {
      const counts = await acceptedCounts(tx, target);
      for (const [professionalId, count] of counts) {
        const written = await tx
          .insert(usageRecord)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            kind: 'whatsapp_messages',
            professionalId,
            period: target,
            quantity: count,
            recordedAt: now,
          })
          .onConflictDoUpdate({
            target: [usageRecord.tenantId, usageRecord.professionalId, usageRecord.period],
            targetWhere: sql`${usageRecord.kind} = 'whatsapp_messages'`,
            set: { quantity: sql`excluded.quantity`, recordedAt: now },
            setWhere: sql`${usageRecord.quantity} is distinct from excluded.quantity`,
          })
          .returning({ id: usageRecord.id });
        months += written.length;
      }
    }
    return { days, months };
  });
}

// Reading the usage ----------------------------------------------------------------------------------

/** The messages the provider accepted (and that were not released) per professional in a period. */
export async function acceptedCounts(tx: Tx, period: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      professionalId: whatsappUsageEvent.professionalId,
      count: sql<number>`count(*)::int`,
    })
    .from(whatsappUsageEvent)
    .where(
      and(
        eq(whatsappUsageEvent.period, period),
        isNotNull(whatsappUsageEvent.confirmedAt),
        isNull(whatsappUsageEvent.releasedAt),
      ),
    )
    .groupBy(whatsappUsageEvent.professionalId);
  return new Map(rows.map((row) => [row.professionalId, row.count]));
}

/**
 * The ids of the counted events per professional in a period, oldest first: what a statement's overage
 * line traces back to. An id is the id of the usage event, which says nothing of the message.
 */
export async function acceptedEventIds(tx: Tx, period: string): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ id: whatsappUsageEvent.id, professionalId: whatsappUsageEvent.professionalId })
    .from(whatsappUsageEvent)
    .where(
      and(
        eq(whatsappUsageEvent.period, period),
        isNotNull(whatsappUsageEvent.confirmedAt),
        isNull(whatsappUsageEvent.releasedAt),
      ),
    )
    .orderBy(asc(whatsappUsageEvent.countedAt), asc(whatsappUsageEvent.id));
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.professionalId) ?? [];
    list.push(row.id);
    grouped.set(row.professionalId, list);
  }
  return grouped;
}

/**
 * What takes a place of the quota now: accepted messages, and the ones reserved and still waiting to
 * go. The same predicate as the quota of the notifications module, so the screen and the sending
 * decision never disagree.
 */
export async function quotaCounts(tx: Tx, period: string): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      professionalId: whatsappUsageEvent.professionalId,
      count: sql<number>`count(*)::int`,
    })
    .from(whatsappUsageEvent)
    .innerJoin(
      message,
      and(
        eq(message.tenantId, whatsappUsageEvent.tenantId),
        eq(message.id, whatsappUsageEvent.messageId),
      ),
    )
    .where(
      and(
        eq(whatsappUsageEvent.period, period),
        isNull(whatsappUsageEvent.releasedAt),
        or(isNotNull(whatsappUsageEvent.confirmedAt), eq(message.status, 'queued')),
      ),
    )
    .groupBy(whatsappUsageEvent.professionalId);
  return new Map(rows.map((row) => [row.professionalId, row.count]));
}

/** The days of a period on which each professional was active, from the snapshots. */
export async function recordedDays(tx: Tx, period: string): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ professionalId: usageRecord.professionalId, day: usageRecord.day })
    .from(usageRecord)
    .where(and(eq(usageRecord.kind, 'active_professional_day'), eq(usageRecord.period, period)))
    .orderBy(asc(usageRecord.day));
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    if (row.day === null) continue;
    const list = grouped.get(row.professionalId) ?? [];
    list.push(row.day);
    grouped.set(row.professionalId, list);
  }
  return grouped;
}

/** How each professional is called in the directory (a name, never an address). */
export async function professionalNames(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: professional.id, name: membership.displayName })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(inArray(professional.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** The monthly quota of a professional who was active `activeDays` of the `daysInPeriod`. */
export function quotaOf(quotaPerProfessional: number, activeDays: number, daysInPeriod: number) {
  const days = Math.max(0, Math.min(activeDays, daysInPeriod));
  const [share = 0] = allocateProportional(money(quotaPerProfessional), [
    days,
    daysInPeriod - days,
  ]);
  return share;
}

/**
 * The days a professional counts for the quota of a period. A period that ended counts the days that
 * were recorded. The current one counts the days recorded before today, plus today and the rest of
 * the period for a professional who is active now: a professional is not given a smaller quota in the
 * first days of the month, and one who leaves stops getting the days after.
 */
export function quotaDays(input: {
  period: string;
  now: Date;
  recorded: readonly string[];
  activeNow: boolean;
}): number {
  const { period, now } = input;
  const days = periodBounds(period).days;
  if (periodOf(now) !== period) return Math.min(new Set(input.recorded).size, days);
  const today = dayOf(now);
  const before = new Set(input.recorded.filter((day) => day < today)).size;
  if (input.activeNow) return Math.min(days, before + daysLeftIncludingToday(now));
  return Math.min(days, before + (input.recorded.includes(today) ? 1 : 0));
}

export interface ProfessionalQuota {
  professionalId: string;
  name: string | null;
  count: number;
  quota: number;
}

export interface QuotaSituation {
  period: string;
  professionals: ProfessionalQuota[];
  /** Messages beyond the quota, all professionals together, before the cap. */
  overageUnits: number;
  /** What the period bills as overage: the units, never above the cap. */
  billableUnits: number;
  capMessages: number;
  /** Overage cannot be sent now: it is off, the cap was reached, or the subscription is still a trial. */
  capReached: boolean;
}

/**
 * Where the quota of every professional stands in a period, and where the overage of the organization
 * stands against its cap. One computation for the screen, the sending decision and the statement, so
 * they cannot disagree.
 */
export async function quotaSituation(
  tx: Tx,
  input: { sub: SubscriptionRow; plan: PlanRow; period: string; now: Date },
): Promise<QuotaSituation> {
  const { sub, plan, period, now } = input;
  const [counts, days, active] = await Promise.all([
    quotaCounts(tx, period),
    recordedDays(tx, period),
    activeProfessionalIds(tx),
  ]);
  const activeSet = new Set(active);
  const ids = [...new Set([...active, ...counts.keys(), ...days.keys()])];
  const names = await professionalNames(tx, ids);
  const daysInPeriod = periodBounds(period).days;

  const professionals = ids
    .map((id) => ({
      professionalId: id,
      name: names.get(id) ?? null,
      count: counts.get(id) ?? 0,
      quota: quotaOf(
        plan.whatsappQuotaPerProfessional,
        quotaDays({
          period,
          now,
          recorded: days.get(id) ?? [],
          activeNow: activeSet.has(id),
        }),
        daysInPeriod,
      ),
    }))
    .sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '') ||
        a.professionalId.localeCompare(b.professionalId),
    );

  const overageUnits = professionals.reduce(
    (sum, entry) => sum + Math.max(0, entry.count - entry.quota),
    0,
  );
  const capMessages = sub.overageCapMessages;
  const billable = sub.status === 'trial' ? 0 : Math.min(overageUnits, capMessages);
  return {
    period,
    professionals,
    overageUnits,
    billableUnits: billable,
    capMessages,
    capReached: sub.status === 'trial' || capMessages === 0 || overageUnits >= capMessages,
  };
}

/** `GET /subscription/usage`: counts, quotas and what the overage would cost, per professional and in total. */
export async function describeUsage(
  tx: Tx,
  input: { sub: SubscriptionRow; plan: PlanRow; now: Date },
): Promise<SubscriptionUsageResponse> {
  const period = periodOf(input.now);
  const situation = await quotaSituation(tx, { ...input, period });
  const rows: SubscriptionUsageResponse['professionals'] = situation.professionals.map((entry) => ({
    professionalId: entry.professionalId,
    name: entry.name,
    count: entry.count,
    quota: entry.quota,
    remaining: Math.max(0, entry.quota - entry.count),
    overageUnits: Math.max(0, entry.count - entry.quota),
    state: stateOf(entry.count, entry.quota),
  }));
  return {
    period,
    professionals: rows,
    totals: {
      count: rows.reduce((sum, row) => sum + row.count, 0),
      quota: rows.reduce((sum, row) => sum + row.quota, 0),
      remaining: rows.reduce((sum, row) => sum + row.remaining, 0),
      overageUnits: situation.overageUnits,
    },
    overage: {
      capMessages: situation.capMessages,
      capMax: input.plan.overageCapMax,
      unitPriceCents: input.plan.overageUnitPriceCents,
      billableUnits: situation.billableUnits,
      projectedCents: situation.billableUnits * input.plan.overageUnitPriceCents,
      capReached: situation.capReached,
    },
  };
}

function stateOf(count: number, quota: number): 'ok' | 'warning' | 'exhausted' {
  if (count >= quota) return 'exhausted';
  return count * 100 >= quota * 80 ? 'warning' : 'ok';
}

// Counts of a tenant for the operator -----------------------------------------------------------------

export const USAGE_PERIODS_SHOWN = 6;

/** The first day of the periods the operator is shown: the latest `USAGE_PERIODS_SHOWN`. */
export function earliestPeriodShown(now: Date): string {
  let period = periodOf(now);
  for (let index = 1; index < USAGE_PERIODS_SHOWN; index += 1) period = previousPeriod(period);
  return period;
}

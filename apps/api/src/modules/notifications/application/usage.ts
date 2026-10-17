import { and, eq, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import { whatsappUsageAlert, whatsappUsageEvent } from '../../../db/schema/usage-event.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { renderUsageAlertEmail } from '../assets/es-AR/usage-email.js';
import { periodOf, thresholdsReached } from '../domain/usage.js';

import type { Channels, TenantRef } from './deps.js';

/**
 * The monthly WhatsApp quota of each professional: the count, the port the plan plugs into, and the
 * warnings to the owner. Stage 6 (subscriptions) supplies the real `QuotaPolicy`; until then the
 * default allows everything and only counts, also where subscription billing is off.
 */

export interface QuotaPolicy {
  /**
   * The quota of a professional for a month. `limit: null` means no quota applies. With
   * `overageAllowed` the messages past the limit are sent and billed; without it they go by email.
   */
  limitFor(
    tx: Tx,
    professionalId: string,
    period: string,
  ): Promise<{ limit: number | null; overageAllowed: boolean }>;
}

/** The default: no quota, everything is allowed and everything is counted. */
export const UNLIMITED_QUOTA: QuotaPolicy = {
  limitFor: () => Promise.resolve({ limit: null, overageAllowed: true }),
};

export async function usageCount(tx: Tx, professionalId: string, period: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(whatsappUsageEvent)
    .where(
      and(
        eq(whatsappUsageEvent.professionalId, professionalId),
        eq(whatsappUsageEvent.period, period),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Whether one more WhatsApp message may go out for this professional now: there is no quota, the
 * plan allows overage, or the month's count is still under the limit.
 */
export async function whatsappQuotaAvailable(
  quota: QuotaPolicy,
  tx: Tx,
  professionalId: string,
  now: Date,
): Promise<boolean> {
  const period = periodOf(now);
  const { limit, overageAllowed } = await quota.limitFor(tx, professionalId, period);
  if (limit === null || overageAllowed) return true;
  return (await usageCount(tx, professionalId, period)) < limit;
}

async function ownerEmails(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ email: userAccount.email })
    .from(membership)
    .innerJoin(userAccount, eq(userAccount.id, membership.userId))
    .where(and(eq(membership.status, 'active'), sql`'owner' = any(${membership.roles})`));
  return rows.map((row) => row.email);
}

async function professionalName(tx: Tx, professionalId: string): Promise<string | null> {
  const [row] = await tx
    .select({ name: membership.displayName })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(eq(professional.id, professionalId));
  return row?.name ?? null;
}

export interface UsageDeps {
  quota: QuotaPolicy;
  channels: Channels;
}

/**
 * Counts a WhatsApp message the provider accepted against its professional, once, and warns the
 * owner the first time the month's count reaches 80% and 100% of the quota. A warning that cannot
 * be emailed does not undo the count (the owner sees the usage in the settings either way).
 */
export async function recordWhatsappUsage(
  deps: UsageDeps,
  tx: Tx,
  input: { messageId: string; professionalId: string; now: Date; tenant: TenantRef },
): Promise<{ counted: boolean }> {
  const period = periodOf(input.now);
  const [inserted] = await tx
    .insert(whatsappUsageEvent)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      messageId: input.messageId,
      professionalId: input.professionalId,
      countedAt: input.now,
      period,
    })
    .onConflictDoNothing()
    .returning({ id: whatsappUsageEvent.id });
  if (!inserted) return { counted: false };

  const { limit } = await deps.quota.limitFor(tx, input.professionalId, period);
  const count = await usageCount(tx, input.professionalId, period);
  // The row is the "already told": a threshold crossed before is not announced again. One message
  // can cross both thresholds (a tiny quota); the owner gets one email, for the highest.
  let announce: 80 | 100 | null = null;
  for (const threshold of thresholdsReached(count, limit)) {
    const [alert] = await tx
      .insert(whatsappUsageAlert)
      .values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        professionalId: input.professionalId,
        period,
        threshold,
      })
      .onConflictDoNothing()
      .returning({ id: whatsappUsageAlert.id });
    if (alert) announce = threshold;
  }
  if (announce !== null && limit !== null) {
    await warnOwners(deps, tx, {
      tenant: input.tenant,
      professionalId: input.professionalId,
      threshold: announce,
      count,
      limit,
      period,
    });
  }
  return { counted: true };
}

async function warnOwners(
  deps: UsageDeps,
  tx: Tx,
  input: {
    tenant: TenantRef;
    professionalId: string;
    threshold: 80 | 100;
    count: number;
    limit: number;
    period: string;
  },
): Promise<void> {
  const sender = deps.channels.email(input.tenant);
  if (!sender) return;
  const email = renderUsageAlertEmail({
    organizationName: await readOrganizationName(tx),
    professionalName: await professionalName(tx, input.professionalId),
    threshold: input.threshold,
    count: input.count,
    limit: input.limit,
    period: input.period,
  });
  for (const to of await ownerEmails(tx)) {
    try {
      await sender.send({ to, ...email, tenant: input.tenant });
    } catch {
      // Best effort: see recordWhatsappUsage.
    }
  }
}

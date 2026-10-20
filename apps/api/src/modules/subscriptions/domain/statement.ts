import {
  STATEMENT_COLLECTION_DELAY_DAYS,
  allocateProportional,
  money,
} from '@consultorio/contracts';

import { periodBounds } from './periods.js';
import { proratedPrice } from './proration.js';

/**
 * The statement of a billing period (subscriptions, "Billing cycle and statements"). Pure: the days
 * each professional was active, the WhatsApp messages each one sent and the plan come in; the lines
 * and the total come out, in whole cents, so the owner sees exactly what will be collected.
 *
 * - **Professionals.** Each professional pays the price of the plan prorated by the days of the period
 *   they were active AFTER the trial (`domain/proration.ts`): a professional active the whole period
 *   pays the whole price. Days inside the trial are free.
 * - **Quota.** Each professional's quota is the plan's quota prorated by the days they were active,
 *   the trial included (a professional deactivated mid-period stops receiving quota, by the same
 *   rule as the price).
 * - **Overage.** The messages a professional sent beyond their quota are overage, billed at the unit
 *   price of the plan, and never more than the cap of the organization for the period: the cap is a
 *   maximum of overage messages per period, per organization, and it always applies.
 * - **Traceable.** An overage line lists the ids of the counted events it bills (never their text or
 *   their patient), so a disputed line can be traced to events.
 */

export interface StatementProfessional {
  id: string;
  /** How the professional appears in the directory; null when the member has no name. */
  name: string | null;
  /** The billing days (`YYYY-MM-DD`) of the period on which the professional was active. */
  days: readonly string[];
  /** The ids of the usage events (accepted WhatsApp messages) counted for this professional in the period, oldest first. */
  eventIds: readonly string[];
}

export interface StatementPlan {
  pricePerProfessionalCents: number;
  whatsappQuotaPerProfessional: number;
  overageUnitPriceCents: number;
}

export type StatementLine =
  | {
      kind: 'professional';
      professionalId: string;
      name: string | null;
      /** The days billed (after the trial) out of the days of the period. */
      days: number;
      daysInPeriod: number;
      amountCents: number;
    }
  | {
      kind: 'overage';
      professionalId: string;
      name: string | null;
      /** The quota of the professional for this period, after the proration. */
      quota: number;
      /** The messages counted for the professional in the period. */
      used: number;
      /** The messages billed as overage. */
      units: number;
      unitPriceCents: number;
      amountCents: number;
      /** The counted events that are billed, by id. */
      eventIds: readonly string[];
    };

export interface StatementContent {
  period: string;
  professionalsCounted: number;
  baseCents: number;
  overageUnits: number;
  overageCents: number;
  totalCents: number;
  lines: StatementLine[];
}

export interface StatementInput {
  period: string;
  plan: StatementPlan;
  /** The first day (`YYYY-MM-DD`) that is billed: the day the trial ended. */
  billingStartDay: string;
  /** The most overage messages the organization accepts for the period. */
  overageCapMessages: number;
  professionals: readonly StatementProfessional[];
}

/** The statement of a period, or null when no professional was active on a billed day. */
export function buildStatement(input: StatementInput): StatementContent | null {
  const { period, plan } = input;
  const daysInPeriod = periodBounds(period).days;

  const billed = input.professionals
    .map((professional) => ({
      professional,
      // The days that are priced: the ones after the trial.
      days: new Set(professional.days.filter((day) => day >= input.billingStartDay)).size,
      // The days that give quota: every day the professional was active, the trial included.
      activeDays: new Set(professional.days).size,
    }))
    .filter((entry) => entry.days > 0)
    .sort(
      (a, b) =>
        (a.professional.name ?? a.professional.id).localeCompare(
          b.professional.name ?? b.professional.id,
        ) || a.professional.id.localeCompare(b.professional.id),
    );
  if (billed.length === 0) return null;

  const lines: StatementLine[] = [];
  let baseCents = 0;
  const overages: { entry: (typeof billed)[number]; quota: number; raw: number }[] = [];
  for (const entry of billed) {
    const amountCents = proratedPrice(plan.pricePerProfessionalCents, entry.days, daysInPeriod);
    baseCents += amountCents;
    lines.push({
      kind: 'professional',
      professionalId: entry.professional.id,
      name: entry.professional.name,
      days: entry.days,
      daysInPeriod,
      amountCents,
    });
    const [quota = 0] = allocateProportional(money(plan.whatsappQuotaPerProfessional), [
      entry.activeDays,
      daysInPeriod - entry.activeDays,
    ]);
    overages.push({
      entry,
      quota,
      raw: Math.max(0, entry.professional.eventIds.length - quota),
    });
  }

  const rawTotal = overages.reduce((sum, overage) => sum + overage.raw, 0);
  const billedUnits = Math.min(rawTotal, Math.max(0, input.overageCapMessages));
  const shares =
    billedUnits === 0 || rawTotal === 0
      ? overages.map(() => 0)
      : allocateProportional(
          money(billedUnits),
          overages.map((overage) => overage.raw),
        );
  let overageCents = 0;
  overages.forEach((overage, index) => {
    const units = shares[index] ?? 0;
    if (units === 0) return;
    const amountCents = units * plan.overageUnitPriceCents;
    overageCents += amountCents;
    lines.push({
      kind: 'overage',
      professionalId: overage.entry.professional.id,
      name: overage.entry.professional.name,
      quota: overage.quota,
      used: overage.entry.professional.eventIds.length,
      units,
      unitPriceCents: plan.overageUnitPriceCents,
      amountCents,
      eventIds: overage.entry.professional.eventIds.slice(overage.quota, overage.quota + units),
    });
  });

  return {
    period,
    professionalsCounted: billed.length,
    baseCents,
    overageUnits: billedUnits,
    overageCents,
    totalCents: baseCents + overageCents,
    lines,
  };
}

// Collection ----------------------------------------------------------------------------------

/**
 * When a statement may be collected: never before the owner had `STATEMENT_COLLECTION_DELAY_DAYS`
 * days to see it. The invariant "nothing is collected without a published statement" does not depend
 * on the provider: it is checked here, before any request, and again by the database.
 */
export function collectAfter(publishedAt: Date): Date {
  return new Date(publishedAt.getTime() + STATEMENT_COLLECTION_DELAY_DAYS * 86_400_000);
}

export interface CollectableStatement {
  publishedAt: Date | null;
  collectAfter: Date;
  totalCents: number;
  collectedCents: number;
}

export type CollectionVerdict =
  | { allowed: true; maxCents: number }
  | { allowed: false; reason: 'not_published' | 'too_early' | 'nothing_left' };

/**
 * May `amountCents` be collected now for this statement? Only if the statement was published, its
 * window passed, and the amount does not take the collected total above the statement total.
 */
export function mayCollect(
  statement: CollectableStatement,
  now: Date,
  amountCents: number,
): CollectionVerdict {
  if (statement.publishedAt === null) return { allowed: false, reason: 'not_published' };
  if (now.getTime() < statement.collectAfter.getTime()) {
    return { allowed: false, reason: 'too_early' };
  }
  const left = statement.totalCents - statement.collectedCents;
  if (left <= 0 || amountCents > left || amountCents <= 0) {
    return { allowed: false, reason: 'nothing_left' };
  }
  return { allowed: true, maxCents: left };
}

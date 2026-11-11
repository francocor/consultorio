import { proratedPrice } from './proration.js';

/**
 * What a plan allows and what adding a professional does to the price (subscriptions, "Plan catalog
 * and limits"). Pure: the plan and the counts come in, the answer goes out. The server enforces it
 * (a refusal carries an upgrade path); the screen only shows it.
 *
 * Reception and administration seats are never limited. Actions that protect the safety of a
 * patient or the legal custody of records (reading, exporting, rectifying) are not seats at all and
 * never reach this function.
 */

export interface PlanLimits {
  pricePerProfessionalCents: number;
  maxActiveProfessionals: number;
}

export type SeatCheck =
  | { allowed: true }
  | { allowed: false; reason: 'professional_limit'; limit: number; current: number };

/** May `additional` more professionals become active? */
export function checkProfessionalSeats(
  plan: Pick<PlanLimits, 'maxActiveProfessionals'>,
  activeNow: number,
  additional = 1,
): SeatCheck {
  if (activeNow + additional <= plan.maxActiveProfessionals) return { allowed: true };
  return {
    allowed: false,
    reason: 'professional_limit',
    limit: plan.maxActiveProfessionals,
    current: activeNow,
  };
}

export interface ProfessionalImpact {
  /** Active professionals now and after the change. */
  activeProfessionals: { now: number; after: number };
  /** The monthly price now and after the change, for a full period. */
  monthlyCents: { now: number; after: number };
  /** What the change adds to a full month. */
  monthlyDifferenceCents: number;
  /** What the professionals added cost for the rest of THIS period (from today), prorated by the day. */
  proratedThisPeriodCents: number;
  /** The days left of this period counting today, and the days it has. */
  daysLeft: number;
  daysInPeriod: number;
  limit: { max: number; reached: boolean };
}

/**
 * The price change of adding `additional` professionals today: what the month costs from then on,
 * and what the rest of this period costs (the proration rule of `proration.ts`).
 */
export function professionalImpact(input: {
  plan: PlanLimits;
  activeNow: number;
  additional: number;
  daysLeft: number;
  daysInPeriod: number;
}): ProfessionalImpact {
  const { plan, activeNow, additional } = input;
  const after = activeNow + additional;
  const price = plan.pricePerProfessionalCents;
  return {
    activeProfessionals: { now: activeNow, after },
    monthlyCents: { now: activeNow * price, after: after * price },
    monthlyDifferenceCents: additional * price,
    proratedThisPeriodCents: additional * proratedPrice(price, input.daysLeft, input.daysInPeriod),
    daysLeft: input.daysLeft,
    daysInPeriod: input.daysInPeriod,
    limit: {
      max: plan.maxActiveProfessionals,
      reached: !checkProfessionalSeats(plan, activeNow, additional).allowed,
    },
  };
}

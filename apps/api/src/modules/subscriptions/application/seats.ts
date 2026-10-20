import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { dayOf, daysLeftIncludingToday, periodBounds, periodOf } from '../domain/periods.js';
import {
  checkProfessionalSeats,
  professionalImpact,
  type ProfessionalImpact,
} from '../domain/plan-limits.js';

import {
  countActiveProfessionalsNow,
  countOpenProfessionalInvitations,
  findPlan,
  findSubscription,
  limitsOf,
  readTenantBilling,
} from './store.js';

/** What the staff module asks before it takes another professional seat. */
export interface SeatOptions {
  /** How many professionals would be added. */
  additional?: number;
  now?: Date;
}

/**
 * Refuses a professional that the plan does not allow (subscriptions, "Plan catalog and limits"):
 * `subscription_professional_limit`, whose message offers a plan change. The limit is enforced on the
 * server, whatever the screen showed. Only professional seats are limited: a reception or admin
 * invitation never reaches this function, and neither does a read, an export or any action that
 * protects a patient or the custody of the records.
 *
 * An organization with no plan to hold it to (an exempt one, or one with no subscription) is not
 * limited. The seats that count are the active professionals now plus the invitations to be one that
 * are still open, so ten invitations cannot all pass at the plan's last seat.
 */
export async function assertProfessionalSeatAvailable(
  tx: Tx,
  options: SeatOptions = {},
): Promise<void> {
  const billing = await readTenantBilling(tx);
  if (billing.exempt) return;
  const current = await findSubscription(tx);
  if (!current) return;
  const plan = await findPlan(tx, current.planId);

  const now = options.now ?? new Date();
  const taken =
    (await countActiveProfessionalsNow(tx)) + (await countOpenProfessionalInvitations(tx, now));
  const verdict = checkProfessionalSeats(plan, taken, options.additional ?? 1);
  if (!verdict.allowed) throw new AppError('subscription_professional_limit');
}

export interface PlanImpactPreview {
  exempt: boolean;
  impact: ProfessionalImpact | null;
  periodEndsOn: string | null;
}

/** What adding professionals does to the price today (the numbers of the dialog the owner confirms). */
export async function previewProfessionalImpact(
  tx: Tx,
  options: { additional: number; now: Date },
): Promise<PlanImpactPreview> {
  const billing = await readTenantBilling(tx);
  const current = billing.exempt ? null : await findSubscription(tx);
  if (!current) return { exempt: billing.exempt, impact: null, periodEndsOn: null };
  const plan = await findPlan(tx, current.planId);

  const bounds = periodBounds(periodOf(options.now));
  const taken =
    (await countActiveProfessionalsNow(tx)) +
    (await countOpenProfessionalInvitations(tx, options.now));
  const impact = professionalImpact({
    plan: limitsOf(plan),
    activeNow: taken,
    additional: options.additional,
    daysLeft: daysLeftIncludingToday(options.now),
    daysInPeriod: bounds.days,
  });
  // The last day of the period is the day before the next one starts.
  const periodEndsOn = dayOf(new Date(bounds.end.getTime() - 1));
  return { exempt: false, impact, periodEndsOn };
}

import type { PlanImpact } from '../../onboarding/index.js';
import { takesProfessionalSeat } from '../domain/active-professional.js';

import { findSubscription, readTenantBilling } from './store.js';

/**
 * What inviting or activating a professional does to the price (task 6.8, SUB-01): the answer of
 * `GET /onboarding/invitation-impact`. Only a professional takes a priced seat; reception and
 * administration are free and unlimited, so inviting them never affects the plan. An organization
 * that has no plan to affect (an exempt one: a demo, a deployment without billing; or one with no
 * subscription yet) answers `affectsPlan: false` too.
 *
 * The numbers (the price change and the proration) are on `GET /subscription/plan-impact`, which
 * only the owner reads: this answer is the one the guided first run shows to anybody who invites.
 */
export function createSubscriptionPlanImpact(): PlanImpact {
  return {
    async preview(tx, input) {
      if (!takesProfessionalSeat(input.roles)) return { affectsPlan: false };
      const billing = await readTenantBilling(tx);
      if (billing.exempt) return { affectsPlan: false };
      return { affectsPlan: (await findSubscription(tx)) !== null };
    },
  };
}

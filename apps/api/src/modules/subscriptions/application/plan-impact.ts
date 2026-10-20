import { noPlanImpact, type PlanImpact } from '../../onboarding/index.js';

/**
 * What inviting or activating a professional does to the price (task 6.8, SUB-01): the answer of
 * `GET /onboarding/invitation-impact`. Seam skeleton: until the subscriptions track fills it in,
 * nothing changes the plan, exactly as before Stage 6. The real one answers `affectsPlan: false`
 * for an exempt organization too (single mode, a demo), where there is no plan.
 */
export function createSubscriptionPlanImpact(): PlanImpact {
  return noPlanImpact;
}

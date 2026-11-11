import type { SUBSCRIPTION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of the subscription are proven. Track A (subscriptions) replaces each
 * `pending` with the integration test that names the action, in this file only.
 */
export const SUBSCRIPTION_SCENARIOS: Record<
  (typeof SUBSCRIPTION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'subscription.created': t('subscription-state.test.ts'),
  'subscription.plan_changed': t('billing-timeline.test.ts'),
  'subscription.state_changed': t('billing-timeline.test.ts'),
  'subscription.cap_changed': t('quota-policy.test.ts'),
  'subscription.surplus_flagged': t('mp-webhook.test.ts'),
  'subscription.refunded': t('mp-webhook.test.ts'),
  'subscription.preapproval_cancelled': t('subscription-superseded.test.ts'),
  'subscription.parked_resolved': t('subscription-parked.test.ts'),
  'subscription.surplus_reviewed': t('subscription-operator-billing.test.ts'),
};

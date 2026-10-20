import type { SUBSCRIPTION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the subscription are proven. Track A (subscriptions) replaces each
 * `pending` with the integration test that names the action, in this file only.
 */
export const SUBSCRIPTION_SCENARIOS: Record<
  (typeof SUBSCRIPTION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'subscription.created': {
    pending: 'S6.03 (task 6.14): the owner subscribes through the checkout',
  },
  'subscription.plan_changed': { pending: 'S6.04 (task 6.21): plan change, cancel and reactivate' },
  'subscription.state_changed': {
    pending: 'S6.04 (tasks 6.18 and 6.19): trial end, dunning, read-only and recovery',
  },
  'subscription.cap_changed': { pending: 'S6.06 (task 6.27): the owner sets the overage cap' },
  'subscription.surplus_flagged': {
    pending: 'S6.03 (task 6.16): a second approved payment for the same period',
  },
  'subscription.refunded': { pending: 'S6.03 (task 6.16): the operator refunds a payment' },
};

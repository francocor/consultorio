import type { SIGNUP_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the signup are proven. Track B (signup) replaces each `pending` with
 * the integration test that names the action, in this file only. `signup.purged` is a platform
 * action (the organization is gone): it is proven in the operator trail tests, not here.
 */
export const SIGNUP_SCENARIOS: Record<(typeof SIGNUP_AUDIT_ACTIONS)[number], AuditScenario> = {
  'signup.created': { pending: 'S6.02 (task 6.10): a visitor signs up' },
  'signup.verified': { pending: 'S6.02 (task 6.11): the emailed link activates the organization' },
  'terms.accepted': { pending: 'S6.02 (task 6.10): the two acceptances of the signup' },
};

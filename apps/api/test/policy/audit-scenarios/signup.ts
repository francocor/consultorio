import type { SIGNUP_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the signup are proven. Track B (signup) replaces each `pending` with
 * the integration test that names the action, in this file only. `signup.purged` is a platform
 * action (the organization is gone): `signup-purge.test.ts` proves it in the platform trail.
 */
const SIGNUP_TEST: AuditScenario = { test: 'apps/api/test/integration/signup.test.ts' };

export const SIGNUP_SCENARIOS: Record<(typeof SIGNUP_AUDIT_ACTIONS)[number], AuditScenario> = {
  // A visitor signs up: the organization exists unverified and its trail starts (task 6.10).
  'signup.created': SIGNUP_TEST,
  // The emailed link activates the organization and signs the owner in (task 6.11).
  'signup.verified': SIGNUP_TEST,
  // The two acceptances of the signup, with their versions (task 6.10).
  'terms.accepted': SIGNUP_TEST,
};

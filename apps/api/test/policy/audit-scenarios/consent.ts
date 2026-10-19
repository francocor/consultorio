import type { CONSENT_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of consent are proven. Track A2 (consent) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
export const CONSENT_SCENARIOS: Record<(typeof CONSENT_AUDIT_ACTIONS)[number], AuditScenario> = {
  'consent.template.created': { pending: 'S5.02 (task 5.9): create a draft template' },
  'consent.template.published': { pending: 'S5.02 (task 5.9): publish a version' },
  'consent.template.retired': { pending: 'S5.02 (task 5.9): retire a template' },
  'consent.requested': { pending: 'S5.03 (task 5.13): request a consent' },
  'consent.signed': { pending: 'S5.03 (task 5.13): sign a consent' },
  'consent.revoked': { pending: 'S5.03 (task 5.14): revoke a consent' },
  'consent.read': { pending: 'S5.03 (task 5.15): every read of a signed consent' },
  'consent.expired': { pending: 'S5.03 (task 5.15): the job that expires requests' },
};

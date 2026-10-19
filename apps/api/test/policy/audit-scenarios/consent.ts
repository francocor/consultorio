import type { CONSENT_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of consent are proven. Track A2 (consent) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
const templates: AuditScenario = { test: 'apps/api/test/integration/consent-templates.test.ts' };

export const CONSENT_SCENARIOS: Record<(typeof CONSENT_AUDIT_ACTIONS)[number], AuditScenario> = {
  'consent.template.created': templates,
  'consent.template.published': templates,
  'consent.template.retired': templates,
  'consent.requested': { pending: 'S5.03 (task 5.13): request a consent' },
  'consent.signed': { pending: 'S5.03 (task 5.13): sign a consent' },
  'consent.revoked': { pending: 'S5.03 (task 5.14): revoke a consent' },
  'consent.read': { pending: 'S5.03 (task 5.15): every read of a signed consent' },
  'consent.expired': { pending: 'S5.03 (task 5.15): the job that expires requests' },
};

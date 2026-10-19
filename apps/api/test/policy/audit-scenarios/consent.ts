import type { CONSENT_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of consent are proven. Track A2 (consent) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
const templates: AuditScenario = {
  test: 'apps/api/test/integration/consent-templates.test.ts',
};
const signing: AuditScenario = { test: 'apps/api/test/integration/consent-signing.test.ts' };

export const CONSENT_SCENARIOS: Record<(typeof CONSENT_AUDIT_ACTIONS)[number], AuditScenario> = {
  'consent.template.created': templates,
  'consent.template.published': templates,
  'consent.template.retired': templates,
  'consent.requested': signing,
  'consent.signed': signing,
  'consent.revoked': signing,
  'consent.read': signing,
  'consent.expired': signing,
};

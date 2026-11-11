import type { PRESCRIPTION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of prescriptions are proven. Track A3 (e-Rx) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
export const PRESCRIPTION_SCENARIOS: Record<
  (typeof PRESCRIPTION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'prescription.issued': t('prescription-issue.test.ts'),
  'prescription.cancelled': t('prescription-lifecycle.test.ts'),
  'prescription.read': t('prescription-access.test.ts'),
  // The staff download is proven in `prescription-access.test.ts`; the portal (S5.09) writes the same
  // action with `via: portal` through `openPortalDocument`.
  'prescription.downloaded': t('prescription-access.test.ts'),
  'prescription.failed': t('prescription-lifecycle.test.ts'),
  'prescription.registered_manually': t('prescription-lifecycle.test.ts'),
};

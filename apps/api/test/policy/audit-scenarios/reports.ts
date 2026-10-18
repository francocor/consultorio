import type { REPORTS_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

const t = (file: string): AuditScenario => ({ test: `apps/api/test/integration/${file}` });

/**
 * Where the audit actions of the reports are proven. Track B (reports) names the integration test
 * that writes each one, in this file only.
 */
export const REPORTS_SCENARIOS: Record<(typeof REPORTS_AUDIT_ACTIONS)[number], AuditScenario> = {
  'report.accessed': t('operational-report.test.ts'),
};

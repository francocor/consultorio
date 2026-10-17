import type { REPORTS_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the reports are proven. Track B (reports) replaces each `pending` with
 * the integration test that names the action, in this file only.
 */
export const REPORTS_SCENARIOS: Record<(typeof REPORTS_AUDIT_ACTIONS)[number], AuditScenario> = {
  'report.accessed': { pending: 'S4.06 (task 4.30): drill-down to patient-level rows' },
};

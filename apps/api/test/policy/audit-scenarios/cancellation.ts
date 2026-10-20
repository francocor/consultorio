import type { CANCELLATION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the cancellation of an organization are proven. Track C (retention)
 * replaces each `pending` with the integration test that names the action, in this file only. The
 * archive actions are platform ones (`ARCHIVE_PLATFORM_AUDIT_ACTIONS`): they are proven in the
 * archive tests against the platform trail, not here.
 */
export const CANCELLATION_SCENARIOS: Record<
  (typeof CANCELLATION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'tenant.cancelled': {
    pending:
      'S6.04 (task 6.21) and S6.08 (task 6.36): the subscription ends, or the operator cancels',
  },
  'export.cancellation.requested': {
    pending: 'S6.08 (task 6.33): the export is built when the organization is cancelled',
  },
  'export.cancellation.downloaded': {
    pending: 'S6.08 (task 6.34): the owner and each professional download their package',
  },
};

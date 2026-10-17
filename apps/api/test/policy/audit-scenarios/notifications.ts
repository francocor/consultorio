import type { NOTIFICATION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of messaging are proven. Track A (notifications) replaces each `pending`
 * with the integration test that names the action, in this file only.
 */
export const NOTIFICATION_SCENARIOS: Record<
  (typeof NOTIFICATION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  'notification.optout.recorded': {
    test: 'apps/api/test/integration/notifications-preferences.test.ts',
  },
  'notification.optin.recorded': {
    test: 'apps/api/test/integration/notifications-preferences.test.ts',
  },
  'notification.resend': { pending: 'S3.06 (task 3.31): manual resend of a message' },
  'notification.integration.changed': {
    test: 'apps/api/test/integration/notifications-integration.test.ts',
  },
};

import type { CANCELLATION_AUDIT_ACTIONS } from '@consultorio/contracts';

import type { AuditScenario } from '../audit-scenarios.js';

/**
 * Where the audit actions of the cancellation of an organization are proven. The archive actions are
 * platform ones (`ARCHIVE_PLATFORM_AUDIT_ACTIONS`): they are proven in the archive tests against the
 * platform trail, not here.
 */
export const CANCELLATION_SCENARIOS: Record<
  (typeof CANCELLATION_AUDIT_ACTIONS)[number],
  AuditScenario
> = {
  // The operator's cancellation (task 6.36). The subscription ending writes the same entry from
  // billing (S6.04); its own test is Track A's to name when it lands.
  'tenant.cancelled': { test: 'apps/api/test/integration/cancellation-export.test.ts' },
  'export.cancellation.requested': {
    test: 'apps/api/test/integration/cancellation-export.test.ts',
  },
  'export.cancellation.downloaded': {
    test: 'apps/api/test/integration/cancellation-export.test.ts',
  },
  'export.cancellation.removed': {
    test: 'apps/api/test/integration/cancellation-export-cleanup.test.ts',
  },
};

import { createReports } from '../../modules/reports/index.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the reports module registers with the composition root (Track B). The track edits this
 * file, `modules/reports/` and nothing shared. Reports own no settings section, no adapter slot and
 * no worker job of their own: an export is built by the shared `export.build` job of billing.
 */
export const reportsWiring: ModuleWiring = {
  name: 'reports',
  create: (context) =>
    createReports({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

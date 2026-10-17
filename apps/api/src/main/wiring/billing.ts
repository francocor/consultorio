import { BillingSettings, DEFAULT_BILLING_SETTINGS } from '@consultorio/contracts';

import { createBilling } from '../../modules/billing/index.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the billing module registers with the composition root (Track A). The track edits this
 * file, `modules/billing/` and nothing shared: it subscribes to the appointment events (a no-show or
 * a cancellation flags the charge for review), sets `needsJobs` for the export job, and adds its
 * worker jobs. Billing owns no external provider, so it has no adapter slot (payments are recorded
 * by hand in Stage 4; the payments gateway is Stage 6).
 */
export const billingWiring: ModuleWiring = {
  name: 'billing',
  settingsSections: [
    { key: 'billing', schema: BillingSettings, defaults: DEFAULT_BILLING_SETTINGS },
  ],
  create: (context) =>
    createBilling({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

import { BillingSettings, DEFAULT_BILLING_SETTINGS } from '@consultorio/contracts';

import { createBilling, createBillingExportJob } from '../../modules/billing/index.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { createConfiguredStorage } from '../storage.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the billing module registers with the composition root (Track A). The track edits this
 * file, `modules/billing/` and nothing shared: it subscribes to the appointment events (a no-show or
 * a cancellation flags the charge for review), sets `needsJobs` for the export job, registers the
 * resource of the `export_download` links with the door of the files, and adds its worker job
 * (`export.build`). Billing owns no external provider, so it has no adapter slot (payments are
 * recorded by hand in Stage 4; the payments gateway is Stage 6).
 */
export const billingWiring: ModuleWiring = {
  name: 'billing',
  settingsSections: [
    { key: 'billing', schema: BillingSettings, defaults: DEFAULT_BILLING_SETTINGS },
  ],
  // An export is asked for in a request and built by a job.
  needsJobs: true,
  create: (context) =>
    createBilling({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      events: context.appointmentEvents,
      jobs: context.jobs,
      fileResources: context.fileResources,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
  worker: ({ config, clock }) => {
    // The bucket of the exports is the one of the documents. It is opened when the first job needs it.
    let storage: ObjectStorage | undefined;
    const bucket = () => {
      if (!storage) storage = createConfiguredStorage(config);
      return storage;
    };
    return {
      jobs: () => {
        const found = bucket();
        // Without a bucket there is nowhere to put a file: the job is not registered, and the API
        // answers "unavailable" to the download.
        return found
          ? [createBillingExportJob({ storage: found, ...(clock ? { clock } : {}) })]
          : [];
      },
    };
  },
};

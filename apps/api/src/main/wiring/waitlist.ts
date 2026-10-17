import { DEFAULT_WAITLIST_SETTINGS, WaitlistSettings } from '@consultorio/contracts';

import { createWaitlist } from '../../modules/waitlist/index.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the waitlist module registers with the composition root (track C). The track edits
 * this file, `modules/waitlist/` and nothing shared: it subscribes to `slot_freed` and adds its
 * jobs to the worker. The waitlist owns no external provider, so it has no adapter slot.
 */
export const waitlistWiring: ModuleWiring = {
  settingsSections: [
    { key: 'waitlist', schema: WaitlistSettings, defaults: DEFAULT_WAITLIST_SETTINGS },
  ],
  name: 'waitlist',
  // A freed slot is matched by a job that the cancellation enqueues in its own transaction.
  needsJobs: true,
  create: (context) =>
    createWaitlist({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      events: context.appointmentEvents,
      jobs: context.jobs,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

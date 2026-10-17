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
  create: (context) =>
    createWaitlist({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

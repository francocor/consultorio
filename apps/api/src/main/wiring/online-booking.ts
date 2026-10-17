import { DEFAULT_ONLINE_BOOKING_SETTINGS, OnlineBookingSettings } from '@consultorio/contracts';

import { createFakeBotChallenge } from '../../adapters/bot-challenge-fake/index.js';
import { createOnlineBooking } from '../../modules/online-booking/index.js';
import { fake } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the online-booking module registers with the composition root (track B). The track
 * edits this file, `modules/online-booking/` and nothing shared: it fills the customer slot of the
 * `botChallenge` port when its local puzzle exists, and adds its jobs to the worker.
 */
export const onlineBookingWiring: ModuleWiring = {
  settingsSections: [
    {
      key: 'onlineBooking',
      schema: OnlineBookingSettings,
      defaults: DEFAULT_ONLINE_BOOKING_SETTINGS,
    },
  ],
  name: 'online-booking',
  // No customer adapter yet: the public forms stay closed; demo organizations get the fake.
  adapters: () => ({ botChallenge: { real: undefined, demo: fake(createFakeBotChallenge()) } }),
  create: (context) =>
    createOnlineBooking({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

import { DEFAULT_ONLINE_BOOKING_SETTINGS, OnlineBookingSettings } from '@consultorio/contracts';

import { createFakeBotChallenge } from '../../adapters/bot-challenge-fake/index.js';
import { createLocalBotChallenge } from '../../adapters/bot-challenge-local/index.js';
import { createOnlineBooking } from '../../modules/online-booking/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake, real } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the online-booking module registers with the composition root (track B). The track
 * edits this file, `modules/online-booking/` and nothing shared: it fills the customer slot of the
 * `botChallenge` port with the local proof of work, and adds its jobs to the worker.
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
  adapters: ({ config }) => ({
    botChallenge: {
      // `BOT_CHALLENGE=local` runs the proof-of-work puzzle for customer organizations. The
      // Cloudflare Turnstile adapter (a deferred task) takes the slot for `turnstile`; until it
      // exists the public forms stay closed in an environment that selects it.
      real: config.providers.botChallenge === 'local' ? real(createLocalBotChallenge()) : undefined,
      demo: fake(createFakeBotChallenge()),
    },
  }),
  devProviders: ({ config }) => [
    {
      id: 'bot-challenge',
      label: 'Bot challenge',
      // The simulators add their mode (an outage, rejected templates) when they exist.
      status: () =>
        Promise.resolve({ adapter: adapterOfSetting(config.providers.botChallenge), mode: null }),
    },
  ],
  create: (context) =>
    createOnlineBooking({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      origins: context.origins,
      appointmentEvents: context.appointmentEvents,
      ...(context.adapters ? { adapters: context.adapters } : {}),
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

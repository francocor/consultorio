import { DEFAULT_ONLINE_BOOKING_SETTINGS, OnlineBookingSettings } from '@consultorio/contracts';

import { createFakeBotChallenge } from '../../adapters/bot-challenge-fake/index.js';
import { createLocalBotChallenge } from '../../adapters/bot-challenge-local/index.js';
import { createBookingNotifier } from '../../modules/notifications/index.js';
import {
  composeBookingConfirmation,
  createBookingPurgeJob,
  createOnlineBooking,
  createOtpSendJob,
} from '../../modules/online-booking/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { METRIC_DESCRIPTIONS } from '../../platform/metrics-catalog.js';
import { createMetrics } from '../../platform/metrics.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import { createTenantRoutedEmail, fake, real } from '../adapter-resolver.js';

import type { ModuleWiring } from './types.js';

/**
 * Everything the online-booking module registers with the composition root (track B). The track
 * edits this file, `modules/online-booking/` and nothing shared: it fills the customer slot of the
 * `botChallenge` port with the local proof of work, and adds its jobs to the worker.
 */
/**
 * What online booking counts in this process (suspicious activity of the public form). The internal
 * metrics endpoint reads it; one registry per process is what the API needs.
 */
export const onlineBookingMetrics = createMetrics({ catalog: METRIC_DESCRIPTIONS });

/** The purge of abandoned submissions runs for every organization once an hour. */
const PURGE_EVERY_MS = 3_600_000;

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
  // The code goes out by a job, so the API process holds a queue client.
  needsJobs: true,
  worker: (context) => {
    // The tenant-routed sender: a demo organization's codes never reach the real provider.
    const email = createTenantRoutedEmail(context.adapters);
    const clock = context.clock ? { clock: context.clock } : {};
    return {
      jobs: () => [createOtpSendJob({ email, ...clock })],
      tenantJobs: [{ definition: createBookingPurgeJob(clock), everyMs: PURGE_EVERY_MS }],
    };
  },
  create: (context) =>
    createOnlineBooking({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      origins: context.origins,
      rateLimitStore: context.rateLimitStore,
      email: context.email,
      // The confirmation goes out through notifications: logged, once, at any hour.
      notifier: createBookingNotifier({
        withTenant: context.withTenant,
        email: context.email,
        clock: context.clock ?? (() => new Date()),
        tokens: createActionTokens({ clock: context.clock ?? (() => new Date()) }),
        compose: (notice) => composeBookingConfirmation(context.origins, notice),
      }),
      worklist: context.worklist,
      metrics: onlineBookingMetrics,
      ...(context.jobs ? { jobs: context.jobs } : {}),
      appointmentEvents: context.appointmentEvents,
      ...(context.adapters ? { adapters: context.adapters } : {}),
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

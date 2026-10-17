import { DEFAULT_WAITLIST_SETTINGS, WaitlistSettings } from '@consultorio/contracts';

import { createSchedulingPorts } from '../../modules/scheduling/index.js';
import {
  WAITLIST_EXPIRE_JOB,
  createEmailOfferDelivery,
  createWaitlist,
  createWaitlistJobs,
} from '../../modules/waitlist/index.js';
import { createTenantKeys } from '../../platform/crypto/tenant-keys.js';
import { createPublicOrigins } from '../../platform/http/public-origin.js';
import { fanOut } from '../../platform/jobs/worker.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import { createTenantRoutedEmail } from '../adapter-resolver.js';
import { deploymentFromConfig } from '../deployment.js';
import { createKeyManagement } from '../key-management.js';

import type { ModuleWiring } from './types.js';

/** The sweep that backs up the exact expiry of every offer runs once a minute. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Everything the waitlist module registers with the composition root (track C). The track edits
 * this file, `modules/waitlist/` and nothing shared: it subscribes to the appointment events (a
 * freed slot starts a match, a taken one ends the offers for it) and adds its jobs to the worker.
 * The waitlist owns no external provider, so it has no adapter slot.
 *
 * Offers go out through `DeliverWaitlistOffer`. The notifications module's `deliverWaitlistOffer`
 * is the real one (it picks WhatsApp or email by the patient's opt-ins and preferences); until it
 * is connected here, `createEmailOfferDelivery` sends a plain email. Connecting it is the one line
 * marked below.
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
  worker: ({ config, adapters, clock }) => {
    const now = clock ?? (() => new Date());
    const origins = createPublicOrigins(deploymentFromConfig(config), {
      secure: config.cookieSecure,
      ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
      ...(config.publicPort === undefined ? {} : { port: config.publicPort }),
    });
    const keys = createTenantKeys({ kms: createKeyManagement(config.kms) });
    // A demonstration organization's email goes to the fake, like every other message.
    const email = createTenantRoutedEmail(adapters);
    return {
      jobs: ({ client }) =>
        Object.values(
          createWaitlistJobs({
            portsOf: (tx) => createSchedulingPorts(tx, { keys }),
            jobs: client,
            clock: now,
            tokens: createActionTokens({ clock: now }),
            origins,
            // CONNECT AT MERGE: replace with the notifications module's `deliverWaitlistOffer`.
            deliver: createEmailOfferDelivery({ email }),
          }),
        ),
      schedules: ({ client, db }) => [
        {
          name: 'waitlist.expire tick',
          intervalMs: SWEEP_EVERY_MS,
          // One sweep per organization and per minute at most, even with several workers.
          run: async () => {
            await fanOut(db, client, WAITLIST_EXPIRE_JOB, { singletonSeconds: 30 });
          },
        },
      ],
    };
  },
};

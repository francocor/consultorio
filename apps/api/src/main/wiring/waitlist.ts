import { DEFAULT_WAITLIST_SETTINGS, WaitlistSettings } from '@consultorio/contracts';

import {
  bindOptOutListener,
  boundDelivery,
  createWhatsappOptInRequests,
  deliverWaitlistOffer,
  offerQuietHoursEnd,
} from '../../modules/notifications/index.js';
import { createSchedulingPorts } from '../../modules/scheduling/index.js';
import {
  WAITLIST_EXPIRE_JOB,
  closeEntriesOfUnreachablePatient,
  createWaitlist,
  createWaitlistJobs,
} from '../../modules/waitlist/index.js';
import { createTenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../platform/db/tenant-context.js';
import { createPublicOrigins } from '../../platform/http/public-origin.js';
import { fanOut } from '../../platform/jobs/worker.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import { deploymentFromConfig } from '../deployment.js';
import { createKeyManagement } from '../key-management.js';

import type { ModuleWiring } from './types.js';

/**
 * Hands an offer to the notifications module. The module binds its queue and providers when its
 * part of the process is built; a process that did not build it would answer "nobody can be
 * reached" for every offer, and the waitlist would flag each patient as unreachable. That is a
 * configuration mistake, so it fails the job (which is retried) instead of rewriting the waitlist.
 */
export function deliverThroughNotifications(
  tx: Tx,
  input: Parameters<typeof deliverWaitlistOffer>[1],
): ReturnType<typeof deliverWaitlistOffer> {
  if (boundDelivery() === undefined) {
    return Promise.reject(
      new Error(
        'The notifications module is not built in this process: offers cannot be delivered',
      ),
    );
  }
  return deliverWaitlistOffer(tx, input);
}

/** The sweep that backs up the exact expiry of every offer runs once a minute. */
const SWEEP_EVERY_MS = 60_000;

/**
 * Everything the waitlist module registers with the composition root (track C). The track edits
 * this file, `modules/waitlist/` and nothing shared: it subscribes to the appointment events (a
 * freed slot starts a match, a taken one ends the offers for it) and adds its jobs to the worker.
 * The waitlist owns no external provider, so it has no adapter slot.
 *
 * Offers go out through `DeliverWaitlistOffer`, which here is the notifications module's
 * `deliverWaitlistOffer`: it picks WhatsApp or email by the patient's opt-ins and preferences, logs
 * the message and sends nothing in quiet hours. The module binds its queue and providers to that
 * function when it is built (`bindOfferDelivery`), in the API process and in the worker, so the
 * worker's notifications wiring must be part of the same process (`MODULE_WIRINGS` is).
 */
export const waitlistWiring: ModuleWiring = {
  settingsSections: [
    { key: 'waitlist', schema: WaitlistSettings, defaults: DEFAULT_WAITLIST_SETTINGS },
  ],
  name: 'waitlist',
  // A freed slot is matched by a job that the cancellation enqueues in its own transaction.
  needsJobs: true,
  create: (context) => {
    // A patient who opts out of a channel leaves the waitlist: messaging tells it, in the same transaction.
    bindOptOutListener((tx, event) =>
      closeEntriesOfUnreachablePatient(tx, {
        patientId: event.patientId,
        now: event.now,
        jobs: context.jobs,
      }).then(() => undefined),
    );
    return createWaitlist({
      // A WhatsApp choice on the public form is a request: the link goes to the verified address.
      whatsappOptIn: createWhatsappOptInRequests({
        tokens: createActionTokens({ clock: context.clock ?? (() => new Date()) }),
        origins: context.origins,
        email: context.email,
      }),
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      events: context.appointmentEvents,
      jobs: context.jobs,
      email: context.email,
      rateLimitStore: context.rateLimitStore,
      adapters: context.adapters,
      ...(context.clock ? { clock: context.clock } : {}),
    });
  },
  worker: ({ config, clock }) => {
    const now = clock ?? (() => new Date());
    const origins = createPublicOrigins(deploymentFromConfig(config), {
      secure: config.cookieSecure,
      ...(config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }),
      ...(config.publicPort === undefined ? {} : { port: config.publicPort }),
    });
    const keys = createTenantKeys({ kms: createKeyManagement(config.kms) });
    return {
      jobs: ({ client }) =>
        Object.values(
          createWaitlistJobs({
            portsOf: (tx) => createSchedulingPorts(tx, { keys }),
            jobs: client,
            clock: now,
            tokens: createActionTokens({ clock: now }),
            origins,
            deliver: deliverThroughNotifications,
            // An offer is put off to the end of quiet hours, which is not a failed delivery.
            quietHoursEnd: offerQuietHoursEnd,
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

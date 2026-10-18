/**
 * Public API of the waitlist module (waiting entries and the offers of freed slots).
 * Other modules and the composition root import from here only.
 *
 * Track C (S3.11 to S3.13) fills this module in: the entries reception manages, the matching of
 * freed slots, the offers with their expiry and the public self-join.
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import type { EmailSender } from '../../platform/mail/email-sender.js';
import { registerTokenHandler } from '../../platform/public/token-router.js';
import { createSchedulingPorts } from '../scheduling/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { exportWaitlist } from './application/export-contributor.js';
import { createJoinLimiter, type WhatsappOptInPort } from './application/join.js';
import { createSlotTrigger } from './application/trigger.js';
import { entryRoutes } from './http/entry-routes.js';
import { createOfferHandler } from './http/offer-handler.js';
import { publicRoutes } from './http/public-routes.js';

export { closeEntriesOfOptedOutPatient, closeExpiredEntries } from './application/entries.js';
export { createWaitlistJobs } from './application/jobs.js';
export { waitlistOutcomes } from './application/outcomes.js';
export type { WaitlistOutcomes } from './application/outcomes.js';
export type { WaitlistJobDeps, WaitlistJobs } from './application/jobs.js';
export type {
  DeliverWaitlistOffer,
  OfferQuietHoursEnd,
  WaitlistOfferDelivered,
  WaitlistOfferDelivery,
} from './application/ports.js';
export { WAITLIST_EXPIRE_JOB, WAITLIST_OFFER_JOB } from './application/offers.js';
export { WAITLIST_MATCH_JOB } from './application/trigger.js';

/** Registers what waitlist takes with an organization that leaves (the cancellation export). */
export function registerWaitlistExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'waitlist', exportWaitlist);
}

export interface WaitlistOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** The key service, for the scheduling ports (they encrypt the detail of worklist items). */
  keys: TenantKeys;
  /** What scheduling publishes: a freed slot starts a match, a taken one ends the offers for it. */
  events: AppointmentEvents;
  /** Enqueues the match of a freed slot. Absent in a deployment without a queue: nothing is matched. */
  jobs?: JobClient | undefined;
  /** Sends the one-time code of a public join. */
  email: EmailSender;
  /** Counts the requests of the public form per address. */
  rateLimitStore: RateLimitStore;
  /** Which adapter serves which organization: the bot challenge of the public form. */
  adapters?: AdapterResolver | undefined;
  /**
   * The request to accept WhatsApp of a patient a public join registered: a link, emailed to the
   * address the visitor verified. The notifications module owns it; the composition root connects
   * it. Absent: the WhatsApp choice stays a preference of the entry.
   */
  whatsappOptIn?: WhatsappOptInPort | undefined;
  clock?: () => Date;
}

export interface Waitlist {
  /** What the module was built with; the track builds its services from it. */
  readonly options: WaitlistOptions;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createWaitlist(options: WaitlistOptions): Waitlist {
  const clock = options.clock ?? (() => new Date());

  // Synchronous and in the transaction of the cancellation or the booking (see the event bus).
  const trigger = createSlotTrigger({ jobs: options.jobs, clock });
  options.events.subscribe((tx, event) => trigger.handle(tx, event));

  // The link of an offer: accept or decline, on the page of the platform's token router.
  registerTokenHandler(
    'waitlist_offer',
    createOfferHandler({
      portsOf: (tx) => createSchedulingPorts(tx, { keys: options.keys, events: options.events }),
      jobs: options.jobs,
    }),
  );

  const entryDeps = {
    portsOf: (tx: Tx) => createSchedulingPorts(tx, { keys: options.keys }),
    jobs: options.jobs,
  };
  const entries = entryRoutes({ withTenant: options.withTenant, entries: entryDeps, clock });
  const pages = publicRoutes({
    withTenant: options.withTenant,
    adapters: options.adapters,
    clock,
    join: {
      keys: options.keys,
      email: options.email,
      limiter: createJoinLimiter(options.rateLimitStore),
      entries: entryDeps,
      ...(options.whatsappOptIn ? { whatsappOptIn: options.whatsappOptIn } : {}),
    },
  });

  return {
    options,
    routes: (app) => {
      entries(app);
      pages(app);
    },
  };
}

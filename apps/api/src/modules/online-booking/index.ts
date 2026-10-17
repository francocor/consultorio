/**
 * Public API of the online-booking module (public booking links, holds and verified submissions).
 * Other modules and the composition root import from here only.
 *
 * Track B (S3.07 to S3.10) fills this module in: the staff routes of the links, the public pages,
 * the slot holds, the verified submission and the confirmation of a booking.
 */
import type { PublicAvailabilityResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import { createMetrics, type Metrics } from '../../platform/metrics.js';
import { createSchedulingPorts } from '../scheduling/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createAbuse } from './application/abuse.js';
import { createAvailabilityCache } from './application/availability-cache.js';
import { exportOnlineBooking } from './application/export-contributor.js';
import { createLinkService } from './application/links.js';
import { linkRoutes } from './http/link-routes.js';
import { publicRoutes } from './http/public-routes.js';

/** Registers what online-booking takes with an organization that leaves (the cancellation export). */
export function registerOnlineBookingExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'online-booking', exportOnlineBooking);
}

/** The free slots a public page remembers (design 5.3). */
const AVAILABILITY_TTL_MS = 30_000;

export { createOtpSendJob } from './application/otp-send-job.js';
export { BOOKING_PURGE_JOB, createBookingPurgeJob } from './application/purge.js';

export interface OnlineBookingOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** The key service, for the scheduling ports (the worklist encrypts its details with it). */
  keys: TenantKeys;
  /** Where emailed links point (never the Host header of a request). */
  origins: PublicOrigins;
  /** Which adapter serves which organization: the bot challenge and the video provider. */
  adapters?: AdapterResolver;
  /** What scheduling publishes; holds publish nothing, bookings publish through scheduling's ports. */
  appointmentEvents?: AppointmentEvents;
  /** Counts the requests of the public form per address and per link. */
  rateLimitStore: RateLimitStore;
  /** Queues the email with the code from a request. Absent: the form cannot be submitted. */
  jobs?: JobClient;
  /** Where the module counts what it sees (suspicious activity). Defaults to a registry of its own. */
  metrics?: Metrics;
  clock?: () => Date;
}

export interface OnlineBooking {
  /** What the module was built with; the track builds its services from it. */
  readonly options: OnlineBookingOptions;
  /** What the module counts, for the internal metrics endpoint. */
  readonly metrics: Metrics;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createOnlineBooking(options: OnlineBookingOptions): OnlineBooking {
  const clock = options.clock ?? (() => new Date());
  const metrics = options.metrics ?? createMetrics();
  const portsOf: Parameters<typeof publicRoutes>[0]['portsOf'] = (tx) =>
    createSchedulingPorts(tx, {
      keys: options.keys,
      ...(options.appointmentEvents ? { events: options.appointmentEvents } : {}),
    });

  const links = linkRoutes({
    withTenant: options.withTenant,
    links: createLinkService(),
    clock,
  });
  const pages = publicRoutes({
    withTenant: options.withTenant,
    origins: options.origins,
    adapters: options.adapters,
    clock,
    portsOf,
    availabilityCache: createAvailabilityCache<PublicAvailabilityResponse>({
      ttlMs: AVAILABILITY_TTL_MS,
      now: () => clock().getTime(),
    }),
    keys: options.keys,
    jobs: options.jobs,
    abuse: createAbuse({ store: options.rateLimitStore, metrics }),
  });

  return {
    options,
    metrics,
    routes: (app) => {
      links(app);
      pages(app);
    },
  };
}

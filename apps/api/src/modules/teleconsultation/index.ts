/**
 * Public API of the teleconsultation module (video links for virtual appointments).
 * Other modules and the composition root import from here only.
 *
 * A virtual appointment has a video session: a room at the provider, named by 128 random bits,
 * reached by the patient through a platform join address that works only inside the join window.
 * The module follows the appointment through the event bus of `platform/events`, and asks the
 * provider for rooms in the worker (`video.link.create`).
 */
import type { FastifyInstance } from 'fastify';

import type { AdapterResolver } from '../../main/adapter-resolver.js';
import type { AuthzOptions } from '../../platform/authz/guard.js';
import type { TenantKeys } from '../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { PublicOrigins } from '../../platform/http/public-origin.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createVideoLinkCreateJob } from './application/create-room-job.js';
import { exportTeleconsultation } from './application/export-contributor.js';
import { createJoinUrlResolver, type VideoJoinUrlResolver } from './application/join-address.js';
import { createSessionSubscriber, type LinkReadyNotifier } from './application/video-sessions.js';
import { type DevVideoControls } from './http/dev-routes.js';
import { publicJoinRoutes } from './http/public-join.js';
import { videoRoutes } from './http/video-routes.js';

export type { VideoLinkProvider, VideoRoom } from './application/ports.js';
export type { VideoJoinAddress, VideoJoinUrlResolver } from './application/join-address.js';
export { createJoinUrlResolver } from './application/join-address.js';
export { devVideoRoutes, type DevVideoControls } from './http/dev-routes.js';
export { createVideoLinkCreateJob };
export { VIDEO_LINK_CREATE_JOB } from './application/video-sessions.js';
export type { LinkReadyNotifier } from './application/video-sessions.js';

/** Registers what teleconsultation takes with an organization that leaves (the cancellation export). */
export function registerTeleconsultationExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'teleconsultation', exportTeleconsultation);
}

export interface TeleconsultationOptions {
  withTenant: WithTenant;
  /** Encrypts the manual links people attach. */
  keys: TenantKeys;
  auditDeny: AuthzOptions['auditDeny'];
  /** The appointment event bus: the module follows the appointment through it. */
  events: AppointmentEvents;
  /** Where the platform join addresses point (the organization's own host). */
  origins: PublicOrigins;
  /** Enqueues the room creation. Absent when the deployment has no queue. */
  jobs?: JobClient;
  /** Which provider serves which organization. */
  adapters?: AdapterResolver;
  clock?: () => Date;
  /** Announces that a link now exists for an appointment (a manual one was attached). */
  onLinkReady?: LinkReadyNotifier;
}

export interface Teleconsultation {
  /** What the module was built with; the track builds its services from it. */
  readonly options: TeleconsultationOptions;
  /**
   * The platform join address of a virtual appointment, for the messages that carry it. The
   * notifications module registers it as its `VideoJoinUrlResolver` (design section 7).
   */
  readonly joinUrlResolver: VideoJoinUrlResolver;
  /** What the simulator console does with the video side (`/operator/dev/video`). */
  readonly devControls: DevVideoControls;
  /** The HTTP routes of the module. */
  routes: (app: FastifyInstance) => void;
}

export function createTeleconsultation(options: TeleconsultationOptions): Teleconsultation {
  const clock = options.clock ?? (() => new Date());
  const tokens = createActionTokens({ clock });

  options.events.subscribe(
    createSessionSubscriber({ jobs: options.jobs, adapters: options.adapters, tokens, clock }),
  );

  const publicJoin = publicJoinRoutes({
    withTenant: options.withTenant,
    keys: options.keys,
    tokens,
    adapters: options.adapters,
    clock,
  });
  const staff = videoRoutes({
    withTenant: options.withTenant,
    keys: options.keys,
    auditDeny: options.auditDeny,
    adapters: options.adapters,
    clock,
    onLinkReady: options.onLinkReady,
  });

  const joinUrlResolver = createJoinUrlResolver({ tokens, origins: options.origins, clock });

  return {
    options,
    joinUrlResolver,
    devControls: {
      issuePatientLink: ({ tenantId, appointmentId }) =>
        options.withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
          joinUrlResolver.resolve(tx, appointmentId),
        ),
    },
    routes: (app) => {
      staff(app);
      publicJoin(app);
    },
  };
}

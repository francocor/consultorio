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
import type { WithTenant } from '../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../platform/events/appointment-events.js';
import type { JobClient } from '../../platform/jobs/boss.js';
import { createActionTokens } from '../../platform/tokens/index.js';
import type { ExportRegistry } from '../tenancy/index.js';

import { createVideoLinkCreateJob } from './application/create-room-job.js';
import { exportTeleconsultation } from './application/export-contributor.js';
import { createSessionSubscriber } from './application/video-sessions.js';
import { publicJoinRoutes } from './http/public-join.js';
import { videoRoutes } from './http/video-routes.js';

export type { VideoLinkProvider, VideoRoom } from './application/ports.js';
export { createVideoLinkCreateJob };
export { VIDEO_LINK_CREATE_JOB } from './application/video-sessions.js';

/** Registers what teleconsultation takes with an organization that leaves (the cancellation export). */
export function registerTeleconsultationExportContributors(registry: ExportRegistry): void {
  registry.registerExportContributor('administrative', 'teleconsultation', exportTeleconsultation);
}

export interface TeleconsultationOptions {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  /** The appointment event bus: the module follows the appointment through it. */
  events: AppointmentEvents;
  /** Enqueues the room creation. Absent when the deployment has no queue. */
  jobs?: JobClient;
  /** Which provider serves which organization. */
  adapters?: AdapterResolver;
  clock?: () => Date;
}

export interface Teleconsultation {
  /** What the module was built with; the track builds its services from it. */
  readonly options: TeleconsultationOptions;
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
    tokens,
    adapters: options.adapters,
    clock,
  });

  const staff = videoRoutes({
    withTenant: options.withTenant,
    auditDeny: options.auditDeny,
    adapters: options.adapters,
    clock,
  });

  return {
    options,
    routes: (app) => {
      staff(app);
      publicJoin(app);
    },
  };
}

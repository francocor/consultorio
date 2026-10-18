import {
  ManualVideoLinkRequest,
  VideoJoinResponse,
  VideoSessionSummary,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { attachManualLink, joinAsProfessional, videoSummary } from '../application/staff-video.js';
import type { LinkReadyNotifier, SessionDeps } from '../application/video-sessions.js';
import { VideoAccessRefused } from '../application/visibility.js';

export interface VideoRoutesDeps {
  withTenant: WithTenant;
  keys: TenantKeys;
  auditDeny: AuthzOptions['auditDeny'];
  adapters: SessionDeps['adapters'];
  clock: () => Date;
  /** Announces that a manual link was attached to an appointment. */
  onLinkReady?: LinkReadyNotifier | undefined;
}

const IdParams = z.strictObject({ id: z.uuid() });

function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw new AppError('unauthenticated');
  return request.actor;
}

/**
 * The staff side of the video link: the summary every role that works on the appointment may read,
 * the professional's join and the manual link fallback. None of them returns an address except the
 * join, and only to the professional of the appointment.
 */
export function videoRoutes(deps: VideoRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    function run<T>(request: FastifyRequest, work: (tx: Tx, actor: Actor) => Promise<T>) {
      const actor = actorOf(request);
      return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
        work(tx, actor),
      );
    }

    /** A refusal of the module becomes the uniform 403, recorded in the audit log. */
    async function refusal(request: FastifyRequest, appointmentId: string, error: unknown) {
      if (error instanceof VideoAccessRefused) {
        return refuseRequest(deps.auditDeny, request, {
          reason: error.reason,
          resourceType: 'appointment',
          resourceId: appointmentId,
        });
      }
      throw error;
    }

    typed.get(
      '/appointments/:id/video',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { params: IdParams, response: { 200: VideoSessionSummary } },
      },
      async (request) => {
        try {
          return await run(request, (tx, actor) =>
            videoSummary(tx, deps, actor, request.params.id),
          );
        } catch (error) {
          return await refusal(request, request.params.id, error);
        }
      },
    );

    typed.post(
      '/appointments/:id/video/join',
      {
        config: {
          readOnly: 'write',
          permission: 'teleconsultation.join',
          audits: ['video.link.joined'],
        },
        schema: {
          params: IdParams,
          body: z.strictObject({}).optional(),
          response: { 200: VideoJoinResponse },
        },
      },
      async (request) => {
        try {
          return await run(request, (tx, actor) =>
            joinAsProfessional(tx, deps, {
              actor,
              appointmentId: request.params.id,
              auditActor: { ...request.auditActor, userId: actor.userId },
            }),
          );
        } catch (error) {
          return await refusal(request, request.params.id, error);
        }
      },
    );

    typed.put(
      '/appointments/:id/video/manual-link',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.book',
          audits: ['video.link.manual_attached'],
        },
        schema: {
          params: IdParams,
          body: ManualVideoLinkRequest,
          response: { 200: VideoSessionSummary },
        },
      },
      async (request) => {
        try {
          return await run(request, async (tx, actor) => {
            await attachManualLink(tx, deps, {
              actor,
              appointmentId: request.params.id,
              url: request.body.url,
              auditActor: { ...request.auditActor, userId: actor.userId },
            });
            return videoSummary(tx, deps, actor, request.params.id);
          });
        } catch (error) {
          return await refusal(request, request.params.id, error);
        }
      },
    );
  };
}

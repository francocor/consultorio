import {
  AvailabilityQuery,
  AvailabilityResponse,
  BookSeriesRequest,
  SeriesCommitResponse,
  SeriesPreviewResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { conflictWith } from '../../../platform/http/problem.js';
import { AccessRefused, visibleLocationIds } from '../../access/index.js';
import { availability } from '../application/availability.js';
import { createSchedulingPorts, isExclusionViolation } from '../application/drizzle-ports.js';
import { SlotTakenError } from '../application/placement.js';
import { bookSeries, SeriesConflictError } from '../application/series.js';

import { locationAuthorizer, replySlotTaken, requestActor } from './appointment-routes.js';

export interface PlanningRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  clock: () => Date;
}

/**
 * The locations a viewer may look at: owners and admins all of them; a professional is held to
 * their own calendar, not to locations; everyone else to the locations they are assigned to.
 */
async function viewerLocations(tx: Tx, actor: Actor): Promise<'all' | string[]> {
  if (actor.roles.some((role) => role === 'owner' || role === 'admin' || role === 'professional')) {
    return 'all';
  }
  return visibleLocationIds(tx, { roles: actor.roles, membershipId: actor.membershipId });
}

/** Free slots and recurring series: the two ways to find and take several times at once. */
export function planningRoutes(deps: PlanningRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/availability',
      {
        config: { readOnly: 'read', permission: 'scheduling.read' },
        schema: { querystring: AvailabilityQuery, response: { 200: AvailabilityResponse } },
      },
      (request) => {
        const { actor, context } = requestActor(request);
        return deps.withTenant(context, async (tx) =>
          availability(createSchedulingPorts(tx, { keys: deps.keys }), {
            query: request.query,
            now: deps.clock(),
            visibleLocations: await viewerLocations(tx, actor),
          }),
        );
      },
    );

    typed.post(
      '/appointments/series',
      {
        config: {
          readOnly: 'write',
          permission: 'scheduling.book',
          audits: ['appointment.created', 'appointment.overridden'],
        },
        schema: {
          body: BookSeriesRequest,
          response: { 200: SeriesPreviewResponse, 201: SeriesCommitResponse },
        },
      },
      async (request, reply) => {
        const { actor, audit, book, context } = requestActor(request);
        try {
          const result = await deps.withTenant(context, (tx) =>
            bookSeries(createSchedulingPorts(tx, { keys: deps.keys }), {
              request: request.body,
              actor: book,
              auditActor: audit,
              now: deps.clock(),
              authorizeLocation: locationAuthorizer(tx, actor),
            }),
          );
          return await reply.code(result.mode === 'commit' ? 201 : 200).send(result);
        } catch (error) {
          if (error instanceof SeriesConflictError) {
            // Nothing was created: the answer says which sessions to skip or fix.
            return conflictWith(request, reply, { occurrences: error.occurrences });
          }
          if (error instanceof SlotTakenError) return replySlotTaken(request, reply, error);
          if (isExclusionViolation(error)) return replySlotTaken(request, reply);
          if (error instanceof AccessRefused) {
            return await refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'appointment',
              metadata: { professionalId: request.body.professionalId },
            });
          }
          throw error;
        }
      },
    );
  };
}

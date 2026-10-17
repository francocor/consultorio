import {
  AvailabilityQuery,
  AvailabilityResponse,
  BookSeriesRequest,
  SeriesCommitResponse,
  SeriesPreviewResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { calendarAccess } from '../../../platform/authz/calendar-scope.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { conflictWith } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { availability } from '../application/availability.js';
import { createSchedulingPorts, isExclusionViolation } from '../application/drizzle-ports.js';
import { SlotTakenError } from '../application/placement.js';
import { bookSeries, SeriesConflictError } from '../application/series.js';

import {
  locationAuthorizer,
  operableLocations,
  replySlotTaken,
  requestActor,
  scopedActor,
} from './appointment-routes.js';

export interface PlanningRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  clock: () => Date;
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
      async (request) => {
        const { actor, context } = requestActor(request);
        // Another professional's free time is part of their calendar: yours or one delegated to you.
        if (!calendarAccess(actor, request.query.professionalId)) {
          return refuseRequest(deps.auditDeny, request, {
            reason: 'not_own_calendar',
            resourceType: 'calendar',
            resourceId: request.query.professionalId,
          });
        }
        return deps.withTenant(context, async (tx) =>
          availability(createSchedulingPorts(tx, { keys: deps.keys }), {
            query: request.query,
            now: deps.clock(),
            visibleLocations: await operableLocations(tx, actor),
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
          const result = await deps.withTenant(context, async (tx) =>
            bookSeries(createSchedulingPorts(tx, { keys: deps.keys }), {
              request: request.body,
              actor: await scopedActor(tx, actor, book),
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

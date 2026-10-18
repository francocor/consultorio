import {
  AppointmentDto,
  ConfirmIdentityRequest,
  WorklistItemDto,
  WorklistQuery,
  WorklistResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../../platform/events/appointment-events.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { createSchedulingPorts } from '../application/drizzle-ports.js';
import { confirmIdentity } from '../application/identity.js';
import type { WorklistService } from '../application/worklist.js';

import { requestActor, scopedActor } from './appointment-routes.js';

export interface WorklistRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  keys: TenantKeys;
  /** Where the appointment events go (reminders, the waitlist, video links subscribe). */
  events?: AppointmentEvents;
  worklist: WorklistService;
}

const IdParams = z.strictObject({ id: z.uuid() });
const NoBody = z.strictObject({});

/**
 * The reception worklist: one queue for everything that needs a person. Owner, admin and reception
 * work it (permission `worklist.manage`); reception sees the locations it is assigned to.
 */
export function worklistRoutes(deps: WorklistRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/worklist',
      {
        config: { readOnly: 'read', permission: 'worklist.manage' },
        schema: { querystring: WorklistQuery, response: { 200: WorklistResponse } },
      },
      (request) => {
        const { actor, context } = requestActor(request);
        return deps.withTenant(context, (tx) =>
          deps.worklist.list(
            tx,
            { roles: actor.roles, membershipId: actor.membershipId },
            request.query,
          ),
        );
      },
    );

    // Confirms the identity of the appointment an identity review is about. The appointment's own
    // professional is refused here, whatever the size of the organization (D14, D18).
    typed.post(
      '/worklist/:id/confirm-identity',
      {
        config: {
          readOnly: 'write',
          permission: 'worklist.manage',
          audits: ['appointment.identity.confirmed'],
        },
        schema: {
          params: IdParams,
          body: ConfirmIdentityRequest,
          response: { 200: AppointmentDto },
        },
      },
      async (request) => {
        const { actor, audit, book, context } = requestActor(request);
        try {
          return await deps.withTenant(context, async (tx) => {
            const item = await deps.worklist.get(
              tx,
              { roles: actor.roles, membershipId: actor.membershipId },
              request.params.id,
            );
            if (item.kind !== 'identity_review' || item.subjectType !== 'appointment') {
              throw new AppError('conflict');
            }
            return confirmIdentity(
              createSchedulingPorts(tx, { keys: deps.keys, events: deps.events }),
              {
                appointmentId: item.subjectId,
                actor: await scopedActor(tx, actor, book),
                auditActor: audit,
                expectedVersion: request.body.expectedVersion,
              },
            );
          });
        } catch (error) {
          if (error instanceof AccessRefused) {
            return await refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'worklist_item',
              resourceId: request.params.id,
            });
          }
          throw error;
        }
      },
    );

    for (const [verb, status, action, resolution] of [
      ['resolve', 'resolved', 'worklist.resolved', 'handled'],
      ['dismiss', 'dismissed', 'worklist.dismissed', 'dismissed'],
    ] as const) {
      typed.post(
        `/worklist/:id/${verb}`,
        {
          config: { readOnly: 'write', permission: 'worklist.manage', audits: [action] },
          schema: { params: IdParams, body: NoBody, response: { 200: WorklistItemDto } },
        },
        (request) => {
          const { actor, audit, context } = requestActor(request);
          return deps.withTenant(context, (tx) =>
            deps.worklist.close(tx, {
              id: request.params.id,
              viewer: { roles: actor.roles, membershipId: actor.membershipId },
              actor: audit,
              status,
              resolution,
            }),
          );
        },
      );
    }
  };
}

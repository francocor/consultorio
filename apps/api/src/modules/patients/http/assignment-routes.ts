import {
  AssignmentDto,
  AssignmentListResponse,
  CreateAssignmentRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { AssignmentService } from '../application/assignments.js';

export interface AssignmentRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  assignments: AssignmentService;
}

const PatientParams = z.strictObject({ id: z.uuid() });
const AssignmentParams = z.strictObject({ id: z.uuid(), professionalId: z.uuid() });

/**
 * Explicit assignment of a patient to a professional. Whoever administers patients may assign and
 * remove; nobody assigns a patient to themselves.
 */
export function assignmentRoutes(deps: AssignmentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/assignments',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: AssignmentListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.assignments.list(tx, request.params.id),
        );
      },
    );

    typed.post(
      '/patients/:id/assignments',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.administer',
          audits: ['assignment.created'],
        },
        schema: {
          params: PatientParams,
          body: CreateAssignmentRequest,
          response: { 201: AssignmentDto },
        },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          const created = await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) =>
              deps.assignments.assign(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                patientId: request.params.id,
                professionalId: request.body.professionalId,
              }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'patient',
              resourceId: request.params.id,
              patientId: request.params.id,
            });
          }
          throw error;
        }
      },
    );

    typed.delete(
      '/patients/:id/assignments/:professionalId',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.administer',
          audits: ['assignment.removed'],
        },
        schema: { params: AssignmentParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.assignments.remove(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            patientId: request.params.id,
            professionalId: request.params.professionalId,
          }),
        );
        return reply.code(204).send();
      },
    );
  };
}

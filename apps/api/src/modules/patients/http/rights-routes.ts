import {
  CreateRightsRequest,
  FulfillRightsRequest,
  FulfillRightsResponse,
  RightsRequestDto,
  RightsRequestListResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { DuplicatePatient } from '../application/patients.js';
import type { RightsService } from '../application/rights.js';

import { demographicsEditor, tenantOf } from './editor.js';

export interface RightsRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  rights: RightsService;
}

const PatientParams = z.strictObject({ id: z.uuid() });
const RequestParams = z.strictObject({ id: z.uuid(), requestId: z.uuid() });

/**
 * Access and rectification requests of a patient. Both are patient-protective: they keep working
 * in a read-only organization, because the right does not lapse with a subscription.
 */
export function rightsRoutes(deps: RightsRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/rights-requests',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: RightsRequestListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.rights.list(tx, request.params.id),
        );
      },
    );

    typed.post(
      '/patients/:id/rights-requests',
      {
        config: {
          readOnly: 'patient_protective',
          permission: 'patients.write',
          audits: ['patient.rights_request.created'],
        },
        schema: {
          params: PatientParams,
          body: CreateRightsRequest,
          response: { 201: RightsRequestDto },
        },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.rights.create(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              patientId: request.params.id,
              request: request.body,
            }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.post(
      '/patients/:id/rights-requests/:requestId/fulfill',
      {
        config: {
          readOnly: 'patient_protective',
          permission: 'patients.write',
          audits: ['patient.rights_request.fulfilled', 'patient.updated'],
        },
        schema: {
          params: RequestParams,
          body: FulfillRightsRequest,
          response: { 200: FulfillRightsResponse },
        },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          return await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.rights.fulfill(tx, {
              editor: {
                actor: { ...request.auditActor, userId: actor.userId },
                ...demographicsEditor(actor),
              },
              country: tenantOf(request).country,
              patientId: request.params.id,
              requestId: request.params.requestId,
              request: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'patient',
              resourceId: request.params.id,
              patientId: request.params.id,
            });
          }
          if (error instanceof DuplicatePatient) throw new AppError('conflict');
          throw error;
        }
      },
    );
  };
}

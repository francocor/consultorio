import { ConsentRecordDto, ConsentResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ConsentService } from '../application/consent.js';

import { tenantOf } from './editor.js';

export interface ConsentRoutesDeps {
  withTenant: WithTenant;
  consent: ConsentService;
}

const PatientParams = z.strictObject({ id: z.uuid() });

/**
 * Data-processing consent of a patient. Recording one is registration work (`patients.write`);
 * revoking it is a patient-protective action, so it keeps working in a read-only organization.
 */
export function consentRoutes(deps: ConsentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/consent',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: ConsentResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.consent.get(tx, request.params.id),
        );
      },
    );

    typed.post(
      '/patients/:id/consent',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['patient.consent.recorded'],
        },
        schema: { params: PatientParams, response: { 201: ConsentRecordDto } },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const recorded = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.consent.record(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              patientId: request.params.id,
              country: tenantOf(request).country,
            }),
        );
        return reply.code(201).send(recorded);
      },
    );

    typed.post(
      '/patients/:id/consent/revoke',
      {
        config: {
          readOnly: 'patient_protective',
          permission: 'patients.write',
          audits: ['patient.consent.revoked'],
        },
        schema: { params: PatientParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.consent.revoke(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            patientId: request.params.id,
          }),
        );
        return reply.code(204).send();
      },
    );
  };
}

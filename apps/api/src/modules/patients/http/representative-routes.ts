import {
  RepresentativeDto,
  RepresentativeInput,
  RepresentativeListResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { RepresentativeService } from '../application/representatives.js';

export interface RepresentativeRoutesDeps {
  withTenant: WithTenant;
  representatives: RepresentativeService;
}

const PatientParams = z.strictObject({ id: z.uuid() });
const RepresentativeParams = z.strictObject({ id: z.uuid(), representativeId: z.uuid() });

function countryOf(request: FastifyRequest): string {
  const context = request.hostContext;
  if (context?.kind !== 'tenant') throw new AppError('unauthenticated');
  return context.tenant.country;
}

/**
 * Representatives of a patient: administrative contacts of a minor (patients, "Minors and
 * representatives"). They give no access to anything; they say whom to call.
 */
export function representativeRoutes(deps: RepresentativeRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/representatives',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: RepresentativeListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.representatives.list(tx, {
            patientId: request.params.id,
            country: countryOf(request),
          }),
        );
      },
    );

    typed.post(
      '/patients/:id/representatives',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['patient.representative.changed'],
        },
        schema: {
          params: PatientParams,
          body: RepresentativeInput,
          response: { 201: RepresentativeDto },
        },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.representatives.add(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              patientId: request.params.id,
              country: countryOf(request),
              representative: request.body,
            }),
        );
        return reply.code(201).send(created);
      },
    );

    typed.delete(
      '/patients/:id/representatives/:representativeId',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['patient.representative.changed'],
        },
        schema: { params: RepresentativeParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.representatives.end(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            patientId: request.params.id,
            representativeId: request.params.representativeId,
            country: countryOf(request),
          }),
        );
        return reply.code(204).send();
      },
    );
  };
}

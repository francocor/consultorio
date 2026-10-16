import {
  AnamnesisResponse,
  AnamnesisVersionDto,
  SaveAnamnesisRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Actor } from '../../../platform/authz/actor.js';
import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { AnamnesisService } from '../application/anamnesis.js';

export interface AnamnesisRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  anamnesis: AnamnesisService;
}

const PatientParams = z.strictObject({ id: z.uuid() });

/** The professional the permission guard let through. Without one the request would not be here. */
function clinicalActor(request: FastifyRequest): Actor & { professionalId: string } {
  const actor = request.actor;
  if (!actor?.professionalId) throw new AppError('forbidden');
  return { ...actor, professionalId: actor.professionalId };
}

/**
 * Anamnesis routes. They carry the `clinical.anamnesis.*` permissions, which only professionals
 * hold: reception, owners and admins are refused by the guard before the handler runs, and the
 * transaction below acts as the professional, so the clinical policies of the database see them.
 */
export function anamnesisRoutes(deps: AnamnesisRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/patients/:id/anamnesis',
      {
        config: {
          readOnly: 'read',
          permission: 'clinical.anamnesis.read',
          audits: ['clinical.anamnesis.read'],
        },
        schema: { params: PatientParams, response: { 200: AnamnesisResponse } },
      },
      async (request) => {
        const actor = clinicalActor(request);
        try {
          return await deps.withTenant(
            {
              tenantId: actor.tenantId,
              userId: actor.userId,
              actingProfessionalId: actor.professionalId,
            },
            (tx) =>
              deps.anamnesis.get(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                professionalId: actor.professionalId,
                patientId: request.params.id,
              }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'anamnesis',
              patientId: request.params.id,
            });
          }
          throw error;
        }
      },
    );

    typed.put(
      '/patients/:id/anamnesis',
      {
        config: {
          readOnly: 'write',
          permission: 'clinical.anamnesis.write',
          audits: ['clinical.anamnesis.updated'],
        },
        schema: {
          params: PatientParams,
          body: SaveAnamnesisRequest,
          response: { 200: AnamnesisVersionDto },
        },
      },
      async (request) => {
        const actor = clinicalActor(request);
        try {
          return await deps.withTenant(
            {
              tenantId: actor.tenantId,
              userId: actor.userId,
              actingProfessionalId: actor.professionalId,
            },
            (tx) =>
              deps.anamnesis.save(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                professionalId: actor.professionalId,
                patientId: request.params.id,
                content: request.body.content,
                expectedVersion: request.body.expectedVersion,
              }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) {
            return refuseRequest(deps.auditDeny, request, {
              reason: error.reason,
              resourceType: 'anamnesis',
              patientId: request.params.id,
            });
          }
          throw error;
        }
      },
    );
  };
}

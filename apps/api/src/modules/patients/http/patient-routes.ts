import {
  CreatePatientRequest,
  CreatePatientResponse,
  PatientDto,
  PatientHistoryResponse,
  PatientSearchQuery,
  PatientSearchResponse,
  UpdatePatientRequest,
  effectivePermissions,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictWith } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { DuplicatePatient, type PatientService } from '../application/patients.js';

export interface PatientRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  patients: PatientService;
}

const PatientParams = z.strictObject({ id: z.uuid() });

function tenantOf(request: FastifyRequest) {
  const context = request.hostContext;
  if (context?.kind !== 'tenant') throw new AppError('unauthenticated');
  return context.tenant;
}

/**
 * Patient registry routes. Demographics are organization-wide: anyone on the staff reads them.
 * Writing needs `patients.write`, and a professional edits only patients they treat unless they
 * administer patients. Nothing here ever carries clinical content.
 */
export function patientRoutes(deps: PatientRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    /** The duplicate-document 409 carries the minimal identity of the patient who holds it. */
    function duplicate(
      request: FastifyRequest,
      reply: Parameters<typeof conflictWith>[1],
      error: DuplicatePatient,
    ) {
      return conflictWith(request, reply, { existingPatient: error.existing });
    }

    typed.post(
      '/patients',
      {
        config: { readOnly: 'write', permission: 'patients.write', audits: ['patient.created'] },
        schema: { body: CreatePatientRequest, response: { 201: CreatePatientResponse } },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          const created = await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) =>
              deps.patients.create(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                country: tenantOf(request).country,
                request: request.body,
              }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          if (error instanceof DuplicatePatient) return duplicate(request, reply, error);
          throw error;
        }
      },
    );

    typed.get(
      '/patients',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { querystring: PatientSearchQuery, response: { 200: PatientSearchResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.patients.search(tx, request.query),
        );
      },
    );

    typed.get(
      '/patients/:id',
      {
        config: { readOnly: 'read', permission: 'patients.read', audits: ['patient.read'] },
        schema: { params: PatientParams, response: { 200: PatientDto } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.patients.get(tx, {
            actor: { ...request.auditActor, userId: actor.userId },
            id: request.params.id,
          }),
        );
      },
    );

    typed.get(
      '/patients/:id/history',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: PatientHistoryResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.patients.history(tx, request.params.id),
        );
      },
    );

    typed.patch(
      '/patients/:id',
      {
        config: { readOnly: 'write', permission: 'patients.write', audits: ['patient.updated'] },
        schema: {
          params: PatientParams,
          body: UpdatePatientRequest,
          response: { 200: PatientDto },
        },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          return await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.patients.update(tx, {
              editor: {
                actor: { ...request.auditActor, userId: actor.userId },
                canAdminister: effectivePermissions(actor.roles, actor.grants).includes(
                  'patients.administer',
                ),
                professionalId: actor.professionalId,
              },
              country: tenantOf(request).country,
              id: request.params.id,
              request: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof DuplicatePatient) return duplicate(request, reply, error);
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

    for (const [verb, status, action] of [
      ['deactivate', 'inactive', 'patient.deactivated'],
      ['reactivate', 'active', 'patient.reactivated'],
    ] as const) {
      typed.post(
        `/patients/:id/${verb}`,
        {
          config: { readOnly: 'write', permission: 'patients.administer', audits: [action] },
          schema: { params: PatientParams, response: { 200: PatientDto } },
        },
        async (request) => {
          const actor = request.actor;
          if (!actor) throw new AppError('unauthenticated');
          return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.patients.setStatus(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              id: request.params.id,
              status,
            }),
          );
        },
      );
    }

    // Patients are never deleted (patients, "No hard deletion; deactivation instead"). The route
    // exists to say so, and to point at deactivation.
    typed.delete(
      '/patients/:id',
      {
        config: { readOnly: 'write', permission: 'patients.administer', audits: 'none' },
        schema: { params: PatientParams },
      },
      () => {
        throw new AppError('conflict', [
          { path: '(root)', i18nKey: 'patients.deletion_not_allowed' },
        ]);
      },
    );
  };
}

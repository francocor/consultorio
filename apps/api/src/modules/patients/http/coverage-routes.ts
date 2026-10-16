import {
  CoverageDto,
  CoverageInput,
  CoverageListResponse,
  CreatePayerPlanRequest,
  PayerCatalogResponse,
  PayerPlanDto,
  PayerPlanListResponse,
  UpdateCoverageRequest,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { AuthzOptions } from '../../../platform/authz/guard.js';
import { refuseRequest } from '../../../platform/authz/refuse.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import type { CoverageService } from '../application/coverage.js';

import { demographicsEditor, tenantOf } from './editor.js';

export interface CoverageRoutesDeps {
  withTenant: WithTenant;
  auditDeny: AuthzOptions['auditDeny'];
  coverage: CoverageService;
}

const PatientParams = z.strictObject({ id: z.uuid() });
const CoverageParams = z.strictObject({ id: z.uuid(), coverageId: z.uuid() });
const PlanParams = z.strictObject({ planId: z.uuid() });

/** Payer plans of the organization and the coverages of its patients. */
export function coverageRoutes(deps: CoverageRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    const refuse = (request: FastifyRequest, error: AccessRefused, patientId: string) =>
      refuseRequest(deps.auditDeny, request, {
        reason: error.reason,
        resourceType: 'patient',
        resourceId: patientId,
        patientId,
      });

    typed.get(
      '/payer-catalog',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { response: { 200: PayerCatalogResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.coverage.catalog(tx, tenantOf(request).country),
        );
      },
    );

    typed.get(
      '/payer-plans',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { response: { 200: PayerPlanListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.coverage.listPlans(tx),
        );
      },
    );

    typed.post(
      '/payer-plans',
      {
        // Enabling a payer is patient administration: reception holds it by default.
        config: { readOnly: 'write', permission: 'patients.administer', audits: 'none' },
        schema: { body: CreatePayerPlanRequest, response: { 201: PayerPlanDto } },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const created = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            deps.coverage.createPlan(tx, {
              country: tenantOf(request).country,
              request: request.body,
            }),
        );
        return reply.code(201).send(created);
      },
    );

    for (const [verb, active] of [
      ['deactivate', false],
      ['reactivate', true],
    ] as const) {
      typed.post(
        `/payer-plans/:planId/${verb}`,
        {
          config: { readOnly: 'write', permission: 'patients.administer', audits: 'none' },
          schema: { params: PlanParams, response: { 200: PayerPlanDto } },
        },
        async (request) => {
          const actor = request.actor;
          if (!actor) throw new AppError('unauthenticated');
          return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.coverage.setPlanActive(tx, { planId: request.params.planId, active }),
          );
        },
      );
    }

    typed.get(
      '/patients/:id/coverages',
      {
        config: { readOnly: 'read', permission: 'patients.read' },
        schema: { params: PatientParams, response: { 200: CoverageListResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          deps.coverage.list(tx, request.params.id),
        );
      },
    );

    typed.post(
      '/patients/:id/coverages',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['patient.coverage.changed'],
        },
        schema: { params: PatientParams, body: CoverageInput, response: { 201: CoverageDto } },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          const created = await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) =>
              deps.coverage.add(tx, {
                actor: { ...request.auditActor, userId: actor.userId },
                editor: demographicsEditor(actor),
                patientId: request.params.id,
                request: request.body,
              }),
          );
          return await reply.code(201).send(created);
        } catch (error) {
          if (error instanceof AccessRefused) return refuse(request, error, request.params.id);
          throw error;
        }
      },
    );

    typed.patch(
      '/patients/:id/coverages/:coverageId',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['patient.coverage.changed'],
        },
        schema: {
          params: CoverageParams,
          body: UpdateCoverageRequest,
          response: { 200: CoverageDto },
        },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          return await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.coverage.update(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              editor: demographicsEditor(actor),
              patientId: request.params.id,
              coverageId: request.params.coverageId,
              request: request.body,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) return refuse(request, error, request.params.id);
          throw error;
        }
      },
    );

    typed.delete(
      '/patients/:id/coverages/:coverageId',
      {
        config: {
          readOnly: 'write',
          permission: 'patients.write',
          audits: ['patient.coverage.changed'],
        },
        schema: { params: CoverageParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        try {
          await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            deps.coverage.remove(tx, {
              actor: { ...request.auditActor, userId: actor.userId },
              editor: demographicsEditor(actor),
              patientId: request.params.id,
              coverageId: request.params.coverageId,
            }),
          );
        } catch (error) {
          if (error instanceof AccessRefused) return refuse(request, error, request.params.id);
          throw error;
        }
        return reply.code(204).send();
      },
    );
  };
}

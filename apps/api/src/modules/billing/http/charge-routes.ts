import {
  AddChargeLineRequest,
  CaptureChargeRequest,
  ChargeDto,
  ChargeListQuery,
  ChargeListResponse,
  type ChargeExistsExtension,
} from '@consultorio/contracts';
import { and, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { charge } from '../../../db/schema/billing-charges.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError, conflictWith } from '../../../platform/http/problem.js';
import { addChargeLine, captureCharge } from '../application/capture-charge.js';
import { loadCharge, loadCharges, scopeCondition, serviceDay } from '../application/charge-view.js';
import { billingScopeOf } from '../application/scope.js';

import { actorOf, billingActorOf } from './context.js';

export interface ChargeRoutesDeps {
  withTenant: WithTenant;
  clock: () => Date;
}

const Params = z.strictObject({ id: z.uuid() });

/**
 * The charges of the organization: capturing one for an appointment, reading them (each viewer
 * sees only their own scope), adding lines. Voiding is in `void-routes.ts`; payments and refunds
 * have their own routes.
 */
export function chargeRoutes(deps: ChargeRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/billing/charges',
      {
        config: {
          readOnly: 'write',
          permission: 'payments.write',
          audits: ['charge.captured', 'billing.price.override'],
        },
        schema: { body: CaptureChargeRequest, response: { 201: ChargeDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const outcome = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            captureCharge(tx, {
              request: request.body,
              actor: billingActorOf(request),
              viewer: actor,
            }),
        );
        if (!outcome.created) {
          const extra: ChargeExistsExtension = { existingChargeId: outcome.existingChargeId };
          return conflictWith(request, reply, extra);
        }
        return reply.code(201).send(outcome.charge);
      },
    );

    typed.get(
      '/billing/charges',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { querystring: ChargeListQuery, response: { 200: ChargeListResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        const query = request.query;
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
          const scope = await billingScopeOf(tx, actor);
          const conditions: (SQL | undefined)[] = [
            scopeCondition(scope),
            query.status ? eq(charge.status, query.status) : undefined,
            query.patientId ? eq(charge.patientId, query.patientId) : undefined,
            query.appointmentId ? eq(charge.appointmentId, query.appointmentId) : undefined,
            query.locationId ? eq(charge.locationId, query.locationId) : undefined,
            query.professionalId ? eq(charge.professionalId, query.professionalId) : undefined,
            query.needsReview === undefined ? undefined : eq(charge.needsReview, query.needsReview),
            // The day of the service as the clock of the location says it.
            query.from ? gte(serviceDay, query.from) : undefined,
            query.to ? lte(serviceDay, query.to) : undefined,
          ];
          return { charges: await loadCharges(tx, [and(...conditions)]) };
        });
      },
    );

    typed.get(
      '/billing/charges/:id',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { params: Params, response: { 200: ChargeDto } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
          const found = await loadCharge(tx, request.params.id, await billingScopeOf(tx, actor));
          if (!found) throw new AppError('not_found');
          return found;
        });
      },
    );

    typed.post(
      '/billing/charges/:id/lines',
      {
        config: { readOnly: 'write', permission: 'payments.write', audits: ['charge.captured'] },
        schema: { params: Params, body: AddChargeLineRequest, response: { 201: ChargeDto } },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const updated = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            addChargeLine(tx, {
              chargeId: request.params.id,
              request: request.body,
              actor: billingActorOf(request),
              viewer: actor,
            }),
        );
        return reply.code(201).send(updated);
      },
    );
  };
}

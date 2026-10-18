import {
  CorrectPaymentRequest,
  PaymentResultResponse,
  ReceivableQuery,
  ReceivablesResponse,
  RecordPaymentRequest,
  RefundPaymentRequest,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { correctPayment, recordPayment, refundPayment } from '../application/payments.js';
import { listReceivables } from '../application/receivables.js';
import { billingScopeOf } from '../application/scope.js';

import { actorOf, billingActorOf } from './context.js';

export interface PaymentRoutesDeps {
  withTenant: WithTenant;
  clock: () => Date;
}

const Params = z.strictObject({ id: z.uuid() });

/**
 * Payments of the patient against a charge, refunds and corrections, and what the payers owe. A
 * payment sent twice with the same key is recorded once: the second answer is the first, with
 * `replayed: true`.
 */
export function paymentRoutes(deps: PaymentRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.post(
      '/billing/charges/:id/payments',
      {
        config: {
          readOnly: 'write',
          permission: 'payments.write',
          audits: ['payment.recorded', 'payment.override'],
        },
        schema: {
          params: Params,
          body: RecordPaymentRequest,
          response: { 200: PaymentResultResponse, 201: PaymentResultResponse },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const outcome = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            recordPayment(tx, {
              chargeId: request.params.id,
              request: request.body,
              actor: billingActorOf(request),
              viewer: actor,
              now: deps.clock(),
            }),
        );
        return reply.code(outcome.replayed ? 200 : 201).send(outcome);
      },
    );

    typed.post(
      '/billing/payments/:id/refund',
      {
        config: { readOnly: 'write', permission: 'payments.refund', audits: ['payment.refunded'] },
        schema: {
          params: Params,
          body: RefundPaymentRequest,
          response: { 200: PaymentResultResponse, 201: PaymentResultResponse },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const outcome = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            refundPayment(tx, {
              paymentId: request.params.id,
              request: request.body,
              actor: billingActorOf(request),
              viewer: actor,
              now: deps.clock(),
            }),
        );
        return reply.code(outcome.replayed ? 200 : 201).send(outcome);
      },
    );

    typed.post(
      '/billing/payments/:id/correct',
      {
        config: {
          readOnly: 'write',
          permission: 'payments.refund',
          audits: ['cash.adjusted', 'payment.recorded', 'payment.override'],
        },
        schema: {
          params: Params,
          body: CorrectPaymentRequest,
          response: { 200: PaymentResultResponse, 201: PaymentResultResponse },
        },
      },
      async (request, reply) => {
        const actor = actorOf(request);
        const outcome = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            correctPayment(tx, {
              paymentId: request.params.id,
              request: request.body,
              actor: billingActorOf(request),
              viewer: actor,
              now: deps.clock(),
            }),
        );
        return reply.code(outcome.replayed ? 200 : 201).send(outcome);
      },
    );

    typed.get(
      '/billing/receivables',
      {
        config: { readOnly: 'read', permission: 'payments.read' },
        schema: { querystring: ReceivableQuery, response: { 200: ReceivablesResponse } },
      },
      (request) => {
        const actor = actorOf(request);
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) =>
          listReceivables(tx, { query: request.query, scope: await billingScopeOf(tx, actor) }),
        );
      },
    );
  };
}

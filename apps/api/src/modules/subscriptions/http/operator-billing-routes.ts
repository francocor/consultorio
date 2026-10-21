import {
  OperatorPaymentsResponse,
  OperatorRefundRequest,
  OperatorRefundResponse,
  OperatorResolveParkedRequest,
  OperatorResolveParkedResponse,
  OperatorSurplusReviewRequest,
  OperatorSurplusReviewResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { subscriptionPayment } from '../../../db/schema/subscriptions.js';
import { writePlatformAudit } from '../../../platform/audit/platform-audit.js';
import { AppError } from '../../../platform/http/problem.js';
import { operatorOf, platformAuditMetaOf, type OperatorRun } from '../../operator/index.js';
import { resolveParked, reviewSurplus } from '../application/parked.js';
import type { SubscriptionDeps } from '../application/provider.js';
import { refundPayment } from '../application/refunds.js';

export interface OperatorBillingDeps {
  run: OperatorRun;
  /** The services that talk to the payments provider, as the jobs and the owner's routes use them. */
  billing: SubscriptionDeps;
}

const TenantParams = z.strictObject({ id: z.uuid() });
const PaymentParams = z.strictObject({ id: z.uuid(), paymentId: z.uuid() });

/**
 * What the platform operator DECIDES about the billing of an organization (JD-S6 R1, C1 and S6-6):
 * lets a subscription that was parked for a person go, refunds a payment, and marks a flagged surplus
 * as looked at. Every one of them carries the operator's id and the reason they gave, in the trail of
 * the platform (the operator's own words) and in the trail of the organization (a code and the
 * numbers), and the refund carries the token the console made for that request, so a double click or
 * a retry after a timeout is one refund.
 *
 * The operator never sees a payer or a card: the list of payments has amounts, states and flags, and
 * the payments provider is reached by the same services as everything else, with the same marks, the
 * same bounded calls and the same settle window. This console does not decide what a provider holds:
 * it asks the platform to look again (`resolve-parked` queues a reconcile).
 */
export function subscriptionOperatorBillingRoutes(deps: OperatorBillingDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const read = { readOnly: 'read', auth: 'public', operatorAuth: 'session' } as const;
    const write = { readOnly: 'write', auth: 'public', operatorAuth: 'session' } as const;

    // The payments of one organization, newest first: what the operator needs to pick one to act on.
    typed.get(
      '/operator/tenants/:id/subscription/payments',
      {
        config: read,
        schema: { params: TenantParams, response: { 200: OperatorPaymentsResponse } },
      },
      async (request) => {
        const { id } = request.params;
        const rows = await deps.run({ tenantId: id }, (tx) =>
          tx
            .select({
              id: subscriptionPayment.id,
              purpose: subscriptionPayment.purpose,
              amountCents: subscriptionPayment.amountCents,
              status: subscriptionPayment.status,
              refundedCents: subscriptionPayment.refundedCents,
              period: subscriptionPayment.period,
              surplus: subscriptionPayment.surplus,
              surplusReviewedAt: subscriptionPayment.surplusReviewedAt,
              createdAt: subscriptionPayment.createdAt,
            })
            .from(subscriptionPayment)
            .where(eq(subscriptionPayment.tenantId, id))
            .orderBy(desc(subscriptionPayment.createdAt), desc(subscriptionPayment.id))
            .limit(100),
        );
        return {
          payments: rows.map((row) => ({
            ...row,
            purpose: row.purpose as 'charge' | 'overdue' | 'statement',
            surplusReviewedAt: row.surplusReviewedAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          })),
        };
      },
    );

    typed.post(
      '/operator/tenants/:id/subscription/resolve-parked',
      {
        config: write,
        schema: {
          params: TenantParams,
          body: OperatorResolveParkedRequest,
          response: { 200: OperatorResolveParkedResponse },
        },
      },
      async (request) => {
        const operator = operatorOf(request);
        const meta = platformAuditMetaOf(request);
        const { id: tenantId } = request.params;

        const outcome = await resolveParked(deps.billing, {
          tenantId,
          actor: { ...meta, userId: operator.id, actingRole: null },
        });
        if (outcome.status !== 'resolved') throw new AppError('conflict');

        await deps.run({ tenantId, operatorId: operator.id }, (tx) =>
          writePlatformAudit(tx, {
            action: 'subscription.parked_resolved',
            outcome: 'allow',
            actor: { ...meta, operatorId: operator.id },
            targetTenantId: tenantId,
            resourceType: 'subscription',
            resourceId: tenantId,
            reason: request.body.reason,
            metadata: {
              attention: outcome.was,
              released: outcome.released,
              reopened: outcome.reopened,
            },
          }),
        );
        return { status: 'resolved' as const, was: outcome.was };
      },
    );

    typed.post(
      '/operator/tenants/:id/subscription/payments/:paymentId/refund',
      {
        config: write,
        schema: {
          params: PaymentParams,
          body: OperatorRefundRequest,
          response: { 200: OperatorRefundResponse },
        },
      },
      async (request) => {
        const operator = operatorOf(request);
        const meta = platformAuditMetaOf(request);
        const { id: tenantId, paymentId } = request.params;
        const { amountCents, reason, token } = request.body;

        // The payment must be one of THIS organization: the id alone names nothing.
        const [payment] = await deps.run({ tenantId }, (tx) =>
          tx
            .select({ id: subscriptionPayment.id })
            .from(subscriptionPayment)
            .where(
              and(
                eq(subscriptionPayment.tenantId, tenantId),
                eq(subscriptionPayment.id, paymentId),
              ),
            ),
        );
        if (!payment) throw new AppError('not_found');

        const outcome = await refundPayment(deps.billing, {
          tenantId,
          paymentId,
          amountCents,
          actor: { ...meta, userId: operator.id, actingRole: null },
          requestedBy: operator.id,
          clientToken: token,
          reason: 'operator_refund',
        });
        switch (outcome.status) {
          case 'refunded':
            break;
          case 'unavailable':
            throw new AppError('subscription_payments_unavailable');
          case 'in_progress':
            throw new AppError('subscription_checkout_in_progress');
          case 'attention':
            throw new AppError('subscription_needs_attention');
          case 'rejected':
            throw new AppError('subscription_checkout_rejected');
          case 'not_refundable':
            throw new AppError('conflict');
        }

        await deps.run({ tenantId, operatorId: operator.id }, (tx) =>
          writePlatformAudit(tx, {
            action: 'subscription.refunded',
            outcome: 'allow',
            actor: { ...meta, operatorId: operator.id },
            targetTenantId: tenantId,
            resourceType: 'subscription_payment',
            resourceId: paymentId,
            reason,
            metadata: { amountCents: outcome.amountCents, refundId: outcome.refundId },
          }),
        );
        return { status: 'refunded' as const, amountCents: outcome.amountCents };
      },
    );

    typed.post(
      '/operator/tenants/:id/subscription/payments/:paymentId/review',
      {
        config: write,
        schema: {
          params: PaymentParams,
          body: OperatorSurplusReviewRequest,
          response: { 200: OperatorSurplusReviewResponse },
        },
      },
      async (request) => {
        const operator = operatorOf(request);
        const meta = platformAuditMetaOf(request);
        const { id: tenantId, paymentId } = request.params;

        const outcome = await reviewSurplus(deps.billing, {
          tenantId,
          paymentId,
          actor: { ...meta, userId: operator.id, actingRole: null },
        });
        if (outcome !== 'reviewed') throw new AppError('conflict');

        await deps.run({ tenantId, operatorId: operator.id }, (tx) =>
          writePlatformAudit(tx, {
            action: 'subscription.surplus_reviewed',
            outcome: 'allow',
            actor: { ...meta, operatorId: operator.id },
            targetTenantId: tenantId,
            resourceType: 'subscription_payment',
            resourceId: paymentId,
            reason: request.body.reason,
          }),
        );
        return { status: 'reviewed' as const };
      },
    );
  };
}

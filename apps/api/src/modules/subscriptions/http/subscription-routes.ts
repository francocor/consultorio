import {
  ChangePlanRequest,
  CheckoutResponse,
  OverageCapRequest,
  OverageCapResponse,
  PlanImpactQuery,
  PlanImpactResponse,
  PlansResponse,
  RetryPaymentResponse,
  StatementDto,
  StatementsResponse,
  SubscriptionResponse,
  SubscriptionUsageResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { AppError } from '../../../platform/http/problem.js';
import { renderPdf } from '../../../platform/pdf/render.js';
import { startCheckout } from '../application/checkout.js';
import {
  changePlan,
  createOverdueLink,
  listPlans,
  requestCancellation,
  requestReactivation,
  setOverageCap,
} from '../application/management.js';
import type { SubscriptionDeps } from '../application/provider.js';
import { describeSubscription } from '../application/read-model.js';
import { previewProfessionalImpact } from '../application/seats.js';
import { listStatements, readStatement, statementPdfInput } from '../application/statements.js';
import { findPlan, findSubscription, readTenantBilling } from '../application/store.js';
import { describeUsage } from '../application/usage.js';

const StatementParams = z.strictObject({ id: z.uuid() });

export interface SubscriptionRoutesDeps {
  deps: SubscriptionDeps;
  /** Whether the payments provider is a simulator (every screen says so). */
  simulated: () => boolean;
}

/**
 * The owner's view and actions on the subscription (`billing.manage`, owner only). These routes exist
 * only where the deployment bills organizations (the `subscriptions` feature): a single-tenant
 * deployment serves none of them. Reading is always allowed, also in a read-only organization, and so
 * is the owner's management of the subscription (category `subscription`): paying is how it recovers.
 */
export function subscriptionRoutes(options: SubscriptionRoutesDeps) {
  const { deps } = options;
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    typed.get(
      '/subscription',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { response: { 200: SubscriptionResponse } },
      },
      (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          describeSubscription(tx, { simulated: options.simulated() }),
        );
      },
    );

    typed.get(
      '/subscription/plan-impact',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { querystring: PlanImpactQuery, response: { 200: PlanImpactResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const preview = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) =>
            previewProfessionalImpact(tx, {
              additional: request.query.professionals,
              now: deps.clock(),
            }),
        );
        const { impact } = preview;
        if (!impact || preview.periodEndsOn === null) {
          // No plan to affect: an exempt organization, or one with no subscription yet.
          return {
            affectsPlan: false,
            activeProfessionals: { now: 0, after: 0 },
            monthlyCents: { now: 0, after: 0 },
            monthlyDifferenceCents: 0,
            proratedThisPeriodCents: 0,
            daysLeft: 0,
            daysInPeriod: 0,
            periodEndsOn: '',
            limit: { max: 0, reached: false },
          };
        }
        return { affectsPlan: true, ...impact, periodEndsOn: preview.periodEndsOn };
      },
    );

    typed.post(
      '/subscription/checkout',
      {
        config: {
          readOnly: 'subscription',
          permission: 'billing.manage',
          audits: ['subscription.created', 'subscription.state_changed'],
        },
        schema: { response: { 200: CheckoutResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const result = await startCheckout(deps, {
          tenantId: actor.tenantId,
          userId: actor.userId,
          actor: { ...request.auditActor, userId: actor.userId },
        });
        switch (result.status) {
          case 'ready':
            return { checkoutUrl: result.checkoutUrl };
          case 'unavailable':
            throw new AppError('subscription_payments_unavailable');
          case 'in_progress':
            throw new AppError('subscription_checkout_in_progress');
          case 'attention':
            throw new AppError('subscription_needs_attention');
          case 'rejected':
            throw new AppError('subscription_checkout_rejected');
          case 'not_allowed':
            throw new AppError(
              result.reason === 'exempt'
                ? 'subscription_exempt'
                : result.reason === 'cancelled'
                  ? 'subscription_cancelled'
                  : 'subscription_already_subscribed',
            );
        }
      },
    );

    // What the owner sees after an action: the subscription as it is now.
    const viewNow = (actor: { tenantId: string; userId: string }) =>
      deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
        describeSubscription(tx, { simulated: options.simulated() }),
      );
    const ownerOf = (request: FastifyRequest) => {
      const actor = request.actor;
      if (!actor) throw new AppError('unauthenticated');
      return {
        tenantId: actor.tenantId,
        userId: actor.userId,
        actor: { ...request.auditActor, userId: actor.userId },
      };
    };

    typed.get(
      '/subscription/plans',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { response: { 200: PlansResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return {
          plans: await deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
            listPlans(tx),
          ),
        };
      },
    );

    typed.post(
      '/subscription/plan',
      {
        config: {
          readOnly: 'subscription',
          permission: 'billing.manage',
          audits: ['subscription.plan_changed'],
        },
        schema: { body: ChangePlanRequest, response: { 200: SubscriptionResponse } },
      },
      async (request) => {
        const owner = ownerOf(request);
        const outcome = await changePlan(deps, owner, request.body.planKey);
        switch (outcome.status) {
          case 'changed':
          case 'unchanged':
            return viewNow(owner);
          case 'unknown_plan':
            throw new AppError('not_found');
          case 'too_small':
            throw new AppError('subscription_plan_too_small');
          case 'not_allowed':
            throw new AppError(
              outcome.reason === 'exempt'
                ? 'subscription_exempt'
                : outcome.reason === 'cancelled'
                  ? 'subscription_cancelled'
                  : 'not_found',
            );
        }
      },
    );

    typed.post(
      '/subscription/cancel',
      {
        config: {
          readOnly: 'subscription',
          permission: 'billing.manage',
          audits: ['subscription.state_changed', 'tenant.cancelled'],
        },
        schema: { response: { 200: SubscriptionResponse } },
      },
      async (request) => {
        const owner = ownerOf(request);
        const outcome = await requestCancellation(deps, owner);
        if (outcome.status === 'not_allowed') {
          throw new AppError(
            outcome.reason === 'exempt'
              ? 'subscription_exempt'
              : outcome.reason === 'cancelled'
                ? 'subscription_cancelled'
                : 'not_found',
          );
        }
        return viewNow(owner);
      },
    );

    typed.post(
      '/subscription/reactivate',
      {
        config: {
          readOnly: 'subscription',
          permission: 'billing.manage',
          audits: ['subscription.state_changed'],
        },
        schema: { response: { 200: SubscriptionResponse } },
      },
      async (request) => {
        const owner = ownerOf(request);
        const outcome = await requestReactivation(deps, owner);
        switch (outcome.status) {
          case 'reactivated':
            return viewNow(owner);
          case 'reauthorization_required':
            throw new AppError('subscription_reauthorization_required');
          case 'in_progress':
            throw new AppError('subscription_checkout_in_progress');
          case 'unavailable':
            throw new AppError('subscription_payments_unavailable');
          case 'not_allowed':
            throw new AppError(
              outcome.reason === 'exempt' ? 'subscription_exempt' : 'subscription_not_cancelling',
            );
        }
      },
    );

    typed.get(
      '/subscription/usage',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { response: { 200: SubscriptionUsageResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, async (tx) => {
          const billing = await readTenantBilling(tx);
          if (billing.exempt) throw new AppError('subscription_exempt');
          const sub = await findSubscription(tx);
          if (!sub) throw new AppError('subscription_not_found');
          const plan = await findPlan(tx, sub.planId);
          return describeUsage(tx, { sub, plan, now: deps.clock() });
        });
      },
    );

    typed.patch(
      '/subscription/overage-cap',
      {
        config: {
          readOnly: 'subscription',
          permission: 'billing.manage',
          audits: ['subscription.cap_changed'],
        },
        schema: { body: OverageCapRequest, response: { 200: OverageCapResponse } },
      },
      async (request) => {
        const outcome = await setOverageCap(
          deps,
          ownerOf(request),
          request.body.overageCapMessages,
        );
        switch (outcome.status) {
          case 'set':
            return { overageCapMessages: outcome.to };
          case 'too_high':
            throw new AppError('subscription_overage_cap_too_high');
          case 'not_allowed':
            throw new AppError(
              outcome.reason === 'exempt' ? 'subscription_exempt' : 'subscription_not_found',
            );
        }
      },
    );

    typed.get(
      '/subscription/statements',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { response: { 200: StatementsResponse } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return {
          statements: await deps.withTenant(
            { tenantId: actor.tenantId, userId: actor.userId },
            (tx) => listStatements(tx, deps.clock()),
          ),
        };
      },
    );

    typed.get(
      '/subscription/statements/:id',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { params: StatementParams, response: { 200: StatementDto } },
      },
      async (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const found = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => readStatement(tx, request.params.id, deps.clock()),
        );
        if (!found) throw new AppError('not_found');
        return found;
      },
    );

    typed.get(
      '/subscription/statements/:id/document',
      {
        config: { readOnly: 'read', permission: 'billing.manage' },
        schema: { params: StatementParams },
      },
      async (request, reply) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        const prepared = await deps.withTenant(
          { tenantId: actor.tenantId, userId: actor.userId },
          (tx) => statementPdfInput(tx, request.params.id, { simulated: options.simulated() }),
        );
        if (!prepared) throw new AppError('not_found');
        const bytes = await renderPdf(prepared.input);
        // Authenticated, never cached or sniffed: it is the owner's accounting.
        return reply
          .header('content-type', 'application/pdf')
          .header('content-disposition', `attachment; filename="${prepared.fileName}"`)
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox; frame-ancestors 'none'")
          .send(bytes);
      },
    );

    typed.post(
      '/subscription/retry-payment',
      {
        config: {
          readOnly: 'subscription',
          permission: 'billing.manage',
          audits: ['subscription.state_changed'],
        },
        schema: { response: { 200: RetryPaymentResponse } },
      },
      async (request) => {
        const outcome = await createOverdueLink(deps, ownerOf(request));
        switch (outcome.status) {
          case 'ready':
            return { paymentUrl: outcome.paymentUrl };
          case 'unavailable':
            throw new AppError('subscription_payments_unavailable');
          case 'in_progress':
            throw new AppError('subscription_checkout_in_progress');
          case 'attention':
            throw new AppError('subscription_needs_attention');
          case 'rejected':
            throw new AppError('subscription_checkout_rejected');
          case 'not_allowed':
            throw new AppError(
              outcome.reason === 'exempt' ? 'subscription_exempt' : 'subscription_nothing_due',
            );
        }
      },
    );
  };
}

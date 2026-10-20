import {
  ChangePlanRequest,
  CheckoutResponse,
  PlanImpactQuery,
  PlanImpactResponse,
  PlansResponse,
  RetryPaymentResponse,
  SubscriptionResponse,
} from '@consultorio/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { AppError } from '../../../platform/http/problem.js';
import { startCheckout } from '../application/checkout.js';
import {
  changePlan,
  createOverdueLink,
  listPlans,
  requestCancellation,
  requestReactivation,
} from '../application/management.js';
import type { SubscriptionDeps } from '../application/provider.js';
import { describeSubscription } from '../application/read-model.js';
import { previewProfessionalImpact } from '../application/seats.js';

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

import {
  CheckoutResponse,
  PlanImpactQuery,
  PlanImpactResponse,
  SubscriptionResponse,
} from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { AppError } from '../../../platform/http/problem.js';
import { startCheckout } from '../application/checkout.js';
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
  };
}

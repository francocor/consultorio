import { PlanImpactQuery, PlanImpactResponse, SubscriptionResponse } from '@consultorio/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { describeSubscription } from '../application/read-model.js';
import { previewProfessionalImpact } from '../application/seats.js';

export interface SubscriptionRoutesDeps {
  withTenant: WithTenant;
  clock: () => Date;
  /** Whether the payments provider is a simulator (every screen says so). */
  simulated: () => boolean;
}

/**
 * The owner's view of the subscription (`billing.manage`, owner only). These routes exist only where
 * the deployment bills organizations (the `subscriptions` feature): a single-tenant deployment
 * serves none of them. Reading is always allowed, also in a read-only organization.
 */
export function subscriptionRoutes(deps: SubscriptionRoutesDeps) {
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
          describeSubscription(tx, { simulated: deps.simulated() }),
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
  };
}

import {
  OperatorSubscriptionDto,
  OperatorSubscriptionsResponse,
  type SubscriptionStatus,
} from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { plan, subscription } from '../../../db/schema/subscriptions.js';
import { AppError } from '../../../platform/http/problem.js';
import type { OperatorRun } from '../../operator/index.js';

/** The operator reads the subscription of an organization through the `app_operator` role. */
export interface SubscriptionOperatorDeps {
  run: OperatorRun;
}

const TenantParams = z.strictObject({ id: z.uuid() });

const SELECTED = {
  tenantId: subscription.tenantId,
  status: subscription.status,
  planKey: plan.key,
  trialEndsAt: subscription.trialEndsAt,
  graceEndsAt: subscription.graceEndsAt,
  paidThrough: subscription.paidThrough,
  dunningStep: subscription.dunningStep,
  authorizationState: subscription.authorizationState,
  overageCapMessages: subscription.overageCapMessages,
} as const;

interface Selected {
  tenantId: string;
  status: string;
  planKey: string;
  trialEndsAt: Date;
  graceEndsAt: Date | null;
  paidThrough: Date | null;
  dunningStep: number;
  authorizationState: string;
  overageCapMessages: number;
}

function toDto(row: Selected): OperatorSubscriptionDto {
  return {
    id: row.tenantId,
    status: row.status as SubscriptionStatus,
    planKey: row.planKey,
    trialEndsAt: row.trialEndsAt.toISOString(),
    graceEndsAt: row.graceEndsAt?.toISOString() ?? null,
    paidThrough: row.paidThrough?.toISOString() ?? null,
    dunningStep: row.dunningStep,
    authorization: row.authorizationState as OperatorSubscriptionDto['authorization'],
    overageCapMessages: row.overageCapMessages,
  };
}

/**
 * The support view of the subscriptions (SUB-17): the state, its dates and the counters of each
 * organization, behind the operator session. It is billing and usage COUNTS only: the operator's
 * database role has no privilege on any patient or clinical table, so nothing here can reach one,
 * and the columns it may read of the subscription leave out the provider's identifiers.
 */
export function subscriptionOperatorRoutes(deps: SubscriptionOperatorDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const read = { readOnly: 'read', auth: 'public', operatorAuth: 'session' } as const;

    typed.get(
      '/operator/subscriptions',
      { config: read, schema: { response: { 200: OperatorSubscriptionsResponse } } },
      async () => {
        const rows = await deps.run({}, (tx) =>
          tx
            .select(SELECTED)
            .from(subscription)
            .innerJoin(plan, eq(plan.id, subscription.planId))
            .orderBy(asc(subscription.createdAt), asc(subscription.id)),
        );
        return { subscriptions: rows.map(toDto) };
      },
    );

    typed.get(
      '/operator/tenants/:id/subscription',
      {
        config: read,
        schema: { params: TenantParams, response: { 200: OperatorSubscriptionDto } },
      },
      async (request) => {
        const [row] = await deps.run({ tenantId: request.params.id }, (tx) =>
          tx
            .select(SELECTED)
            .from(subscription)
            .innerJoin(plan, eq(plan.id, subscription.planId))
            .where(eq(subscription.tenantId, request.params.id)),
        );
        if (!row) throw new AppError('not_found');
        return toDto(row);
      },
    );
  };
}

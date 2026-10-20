import {
  OperatorSubscriptionDto,
  OperatorSubscriptionsResponse,
  OperatorUsageResponse,
  type SubscriptionStatus,
} from '@consultorio/contracts';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { plan, subscription, usageRecord } from '../../../db/schema/subscriptions.js';
import { AppError } from '../../../platform/http/problem.js';
import type { OperatorRun } from '../../operator/index.js';
import { earliestPeriodShown } from '../application/usage.js';

/** The operator reads the subscription of an organization through the `app_operator` role. */
export interface SubscriptionOperatorDeps {
  run: OperatorRun;
  /** The instant that is "now" (the periods shown are counted back from it). */
  clock?: () => Date;
}

const TenantParams = z.strictObject({ id: z.uuid() });
/** The organization is named in the query: the console reads one at a time. */
const UsageQuery = z.strictObject({ tenantId: z.uuid() });

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
  attentionReason: subscription.attentionReason,
  // Payments flagged as a surplus and not looked at: a count, never a payer.
  surplusFlags: sql<number>`(select count(*)::int from subscription_payment p
      where p.tenant_id = ${subscription.tenantId} and p.surplus and p.surplus_reviewed_at is null)`,
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
  attentionReason: string | null;
  surplusFlags: number;
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
    attentionReason: row.attentionReason,
    surplusFlags: row.surplusFlags,
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

    // The usage of one organization: days of activity and messages per professional and period, counts only.
    typed.get(
      '/operator/usage',
      {
        config: read,
        schema: { querystring: UsageQuery, response: { 200: OperatorUsageResponse } },
      },
      async (request) => {
        const { tenantId } = request.query;
        const since = earliestPeriodShown((deps.clock ?? (() => new Date()))());
        const rows = await deps.run({ tenantId }, (tx) =>
          tx
            .select({
              kind: usageRecord.kind,
              professionalId: usageRecord.professionalId,
              period: usageRecord.period,
              quantity: usageRecord.quantity,
            })
            .from(usageRecord)
            .where(and(eq(usageRecord.tenantId, tenantId), gte(usageRecord.period, since)))
            .orderBy(asc(usageRecord.period), asc(usageRecord.professionalId)),
        );
        type Counts = { activeDays: number; messages: number };
        const periods = new Map<string, Map<string, Counts>>();
        for (const row of rows) {
          const professionals = periods.get(row.period) ?? new Map<string, Counts>();
          const entry = professionals.get(row.professionalId) ?? { activeDays: 0, messages: 0 };
          if (row.kind === 'active_professional_day') entry.activeDays += row.quantity;
          else entry.messages += row.quantity;
          professionals.set(row.professionalId, entry);
          periods.set(row.period, professionals);
        }
        return {
          id: tenantId,
          periods: [...periods.entries()].map(([period, professionals]) => ({
            period,
            professionals: [...professionals.entries()].map(([professionalId, counts]) => ({
              professionalId,
              ...counts,
            })),
          })),
        };
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

import { UsageResponse } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { membership } from '../../../db/schema/identity.js';
import { professional } from '../../../db/schema/staff.js';
import type { Tx, WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { organizationPeriod, usageCount, type QuotaPolicy } from '../application/usage.js';
import { usageState } from '../domain/usage.js';

export interface UsageRoutesDeps {
  withTenant: WithTenant;
  quota: QuotaPolicy;
  clock: () => Date;
}

/** The WhatsApp messages of the month per professional, with the state of their quota. */
export async function usageReport(tx: Tx, quota: QuotaPolicy, now: Date): Promise<UsageResponse> {
  const period = await organizationPeriod(tx, now);
  const professionals = await tx
    .select({ id: professional.id, name: membership.displayName })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(eq(professional.status, 'active'))
    .orderBy(membership.displayName, professional.id);
  const rows: UsageResponse['professionals'] = [];
  for (const entry of professionals) {
    const count = await usageCount(tx, entry.id, period);
    const { limit } = await quota.limitFor(tx, entry.id, period);
    rows.push({
      professionalId: entry.id,
      name: entry.name,
      count,
      limit,
      state: usageState(count, limit),
    });
  }
  return { period, professionals: rows };
}

/** Administration sees the usage before it is billed: counts only, per professional. */
export function usageRoutes(deps: UsageRoutesDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/notifications/usage',
      {
        config: { readOnly: 'read', permission: 'notifications.manage' },
        schema: { response: { 200: UsageResponse } },
      },
      (request) => {
        const actor = request.actor;
        if (!actor) throw new AppError('unauthenticated');
        return deps.withTenant({ tenantId: actor.tenantId, userId: actor.userId }, (tx) =>
          usageReport(tx, deps.quota, deps.clock()),
        );
      },
    );
  };
}

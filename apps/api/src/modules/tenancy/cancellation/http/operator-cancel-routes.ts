import { OperatorCancelTenantRequest, OperatorCancelTenantResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { writePlatformAudit } from '../../../../platform/audit/platform-audit.js';
import { audit } from '../../../../platform/audit/writer.js';
import { AppError } from '../../../../platform/http/problem.js';
import { operatorOf, platformAuditMetaOf, type OperatorRun } from '../../../operator/index.js';
import type { TenantCancelledPort } from '../../application/lifecycle.js';

export interface OperatorCancelDeps {
  run: OperatorRun;
  tenantCancelled: TenantCancelledPort;
  clock?: (() => Date) | undefined;
}

const Params = z.strictObject({ tenantId: z.uuid() });

/**
 * `POST /operator/tenants/:tenantId/cancel`: the operator ends an organization (task 6.36). It is for an
 * organization nobody bills (provisioned by the operator, or a deployment without billing) and for
 * testing the end of an organization locally. An organization that HAS a subscription is refused
 * (JD-S6 R1-S6-2): cancelling its row here would leave the preapproval charging at the provider and
 * let the next event of the subscription move the organization back. Its end is the subscription's own
 * cancellation, which cancels at the provider first and publishes `TenantCancelled` (source
 * `subscription`). The operator states a reason, which goes to the platform trail with their id.
 *
 * The operator role cannot update the tenant row, so the change is the definer function of migration
 * 0651, which refuses a demo organization and one that is already cancelled. The cancellation, the
 * two audit entries (the platform's and the organization's own) and the announcement to the
 * subscribers (the request of the export) are ONE transaction: an announcement that fails undoes the
 * cancellation. No export content passes through here; the operator never reads any.
 */
export function operatorCancelRoutes(deps: OperatorCancelDeps) {
  return (app: FastifyInstance): void => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    const now = deps.clock ?? (() => new Date());

    typed.post(
      '/operator/tenants/:tenantId/cancel',
      {
        config: { readOnly: 'write', auth: 'public', operatorAuth: 'session' },
        schema: {
          params: Params,
          body: OperatorCancelTenantRequest,
          response: { 200: OperatorCancelTenantResponse },
        },
      },
      async (request) => {
        const operator = operatorOf(request);
        const meta = platformAuditMetaOf(request);
        const { tenantId } = request.params;

        return deps.run({ tenantId, operatorId: operator.id }, async (tx) => {
          const result = await tx.execute<{ outcome: string }>(
            sql`select app.operator_cancel_tenant(${tenantId}::uuid) as outcome`,
          );
          const outcome = result.rows[0]?.outcome;
          if (outcome === 'unknown') throw new AppError('not_found');
          if (outcome === 'has_subscription')
            throw new AppError('operator_cancel_has_subscription');
          if (outcome !== 'cancelled') throw new AppError('conflict');

          await writePlatformAudit(tx, {
            action: 'tenant.cancelled',
            outcome: 'allow',
            actor: { ...meta, operatorId: operator.id },
            targetTenantId: tenantId,
            reason: request.body.reason,
            resourceType: 'tenant',
            resourceId: tenantId,
            metadata: { source: 'operator' },
          });
          // The organization's own trail is part of what it takes with it.
          await audit(tx, {
            action: 'tenant.cancelled',
            outcome: 'allow',
            actor: { ...meta, userId: operator.id, actingRole: null },
            resourceType: 'tenant',
            resourceId: tenantId,
            metadata: { source: 'operator' },
          });
          await deps.tenantCancelled.publishCancelled(tx, {
            tenantId,
            cancelledAt: now(),
            source: 'operator',
          });
          return { status: 'cancelled' as const };
        });
      },
    );
  };
}

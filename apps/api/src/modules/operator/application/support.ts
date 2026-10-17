import type { SupportOverviewResponse } from '@consultorio/contracts';
import { asc, eq, sql } from 'drizzle-orm';

import { location, tenant, tenantFeature } from '../../../db/schema/tenant.js';
import {
  writePlatformAudit,
  type PlatformAuditActor,
} from '../../../platform/audit/platform-audit.js';
import { audit } from '../../../platform/audit/writer.js';
import { AppError } from '../../../platform/http/problem.js';

import type { OperatorIdentity, OperatorRun } from './context.js';

export interface OperatorSupport {
  /**
   * What support may see of an organization: its configuration, never its people or its care. It
   * needs an ACTIVE, UNEXPIRED grant from the organization. Every use is audited twice, in the
   * platform trail and in the organization's own trail (where its owner sees it), in the same
   * transaction as the read: if the entry cannot be written, nothing is shown. A refused attempt
   * is recorded too.
   */
  overview(
    tenantId: string,
    operator: OperatorIdentity,
    meta: Omit<PlatformAuditActor, 'operatorId'>,
  ): Promise<SupportOverviewResponse>;
}

interface GrantRow extends Record<string, unknown> {
  id: string | null;
  expiresAt: Date | string | null;
}

export function createOperatorSupport(deps: { run: OperatorRun }): OperatorSupport {
  return {
    async overview(tenantId, operator, meta) {
      const actor = { ...meta, operatorId: operator.id };

      const outcome = await deps.run({ tenantId, operatorId: operator.id }, async (tx) => {
        const [row] = await tx
          .select({
            id: tenant.id,
            slug: tenant.slug,
            status: tenant.status,
            isDemo: tenant.isDemo,
            country: tenant.country,
            theme: tenant.theme,
            createdAt: tenant.createdAt,
          })
          .from(tenant)
          .where(eq(tenant.id, tenantId));
        if (!row) return { kind: 'missing' as const };

        // The same answer the database policies use to let the operator read anything at all.
        const grant = await tx.execute<GrantRow>(
          sql`select id, expires_at as "expiresAt" from app.active_support_grant(${tenantId}::uuid)`,
        );
        const active = grant.rows[0];
        if (!active?.id || !active.expiresAt) {
          await writePlatformAudit(tx, {
            action: 'support.denied',
            outcome: 'deny',
            actor,
            targetTenantId: tenantId,
            reason: 'no_active_grant',
            resourceType: 'tenant',
            resourceId: tenantId,
          });
          return { kind: 'denied' as const };
        }

        await writePlatformAudit(tx, {
          action: 'support.access',
          outcome: 'allow',
          actor,
          targetTenantId: tenantId,
          resourceType: 'support_grant',
          resourceId: active.id,
          metadata: { view: 'overview' },
        });
        await audit(tx, {
          action: 'support.access',
          outcome: 'allow',
          actor: { ...meta, userId: operator.id, actingRole: null },
          resourceType: 'support_grant',
          resourceId: active.id,
          metadata: { view: 'overview', operator: operator.displayName },
        });

        const locations = await tx
          .select({ name: location.name, timeZone: location.timeZone, active: location.active })
          .from(location)
          .orderBy(asc(location.name));
        const features = await tx
          .select({ feature: tenantFeature.feature, enabled: tenantFeature.enabled })
          .from(tenantFeature)
          .orderBy(asc(tenantFeature.feature));
        return {
          kind: 'allowed' as const,
          row,
          locations,
          features,
          expiresAt: new Date(active.expiresAt),
        };
      });

      if (outcome.kind === 'missing') throw new AppError('not_found');
      if (outcome.kind === 'denied') throw new AppError('support_grant_required');

      const name = outcome.row.theme['displayName'];
      return {
        tenant: {
          id: outcome.row.id,
          slug: outcome.row.slug,
          name: typeof name === 'string' && name.trim() !== '' ? name : outcome.row.slug,
          status: outcome.row.status as 'active' | 'read_only' | 'cancelled',
          isDemo: outcome.row.isDemo,
          country: outcome.row.country,
          createdAt: outcome.row.createdAt.toISOString(),
        },
        locations: outcome.locations,
        features: outcome.features,
        grantExpiresAt: outcome.expiresAt.toISOString(),
      };
    },
  };
}

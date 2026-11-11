import { inArray, sql } from 'drizzle-orm';

import { operatorUser } from '../../../db/schema/operator.js';
import { writePlatformAudit } from '../../../platform/audit/platform-audit.js';
import type { WithTenant } from '../../../platform/db/tenant-context.js';

import type { LegalEraseAuditEntry, LegalEraseDeps } from './legal-erase.js';

/** The nil organization: "no organization in particular", for a transaction about the platform. */
const PLATFORM = '00000000-0000-0000-0000-000000000000';

/**
 * The database half of the legal erasure, on the connection of the operator role (`app_operator`, the
 * same one the console uses): it checks that the two people named are active operators, writes the
 * entries of the platform trail with the operator as the actor, and records which folder was erased
 * through the definer function that is the only way to write that state (`app.archive_mark_erased`).
 */
export function createLegalEraseDatabase(deps: {
  withTenant: WithTenant;
  tenantId: string;
  /** The operator who runs the command: the actor of every entry. */
  operatorId: string;
}): Pick<LegalEraseDeps, 'verifyOperators' | 'hasIntent' | 'markErased' | 'audit'> {
  return {
    async verifyOperators(ids) {
      const wanted = [...new Set(ids.map((id) => id.toLowerCase()))];
      const found = await deps.withTenant({ tenantId: PLATFORM, userId: PLATFORM }, (tx) =>
        tx
          .select({ id: operatorUser.id, status: operatorUser.status })
          .from(operatorUser)
          .where(inArray(operatorUser.id, wanted)),
      );
      const active = new Set(found.filter((row) => row.status === 'active').map((row) => row.id));
      if (wanted.some((id) => !active.has(id))) {
        throw new Error('The operator and the approver must be active operators of the console');
      }
    },

    async hasIntent(prefix) {
      // An intent for this folder or for one that contains it (the whole archive covers a narrower rerun).
      // An intent followed by an incomplete run that erased nothing proves nothing was erased: it does not
      // count, or a later listing of the wrong bucket would mark an intact archive erased (JD-S6 R4).
      const found = await deps.withTenant({ tenantId: PLATFORM, userId: PLATFORM }, (tx) =>
        tx.execute<{ found: boolean }>(
          sql`select exists (
                select 1 from platform_audit_event i
                 where i.action = 'archive.erased'
                   and i.target_tenant_id = ${deps.tenantId}::uuid
                   and i.metadata ->> 'phase' = 'intent'
                   and starts_with(${prefix}, i.metadata ->> 'prefix')
                   and not exists (
                     select 1 from platform_audit_event e
                      where e.action = 'archive.erased'
                        and e.target_tenant_id = i.target_tenant_id
                        and e.metadata ->> 'phase' = 'incomplete'
                        and e.metadata ->> 'prefix' = i.metadata ->> 'prefix'
                        and (e.metadata ->> 'objects')::int = 0
                        and e.occurred_at >= i.occurred_at
                   )
              ) as found`,
        ),
      );
      return found.rows[0]?.found === true;
    },

    async markErased(prefix) {
      await deps.withTenant({ tenantId: deps.tenantId, userId: deps.operatorId }, (tx) =>
        tx.execute(sql`select app.archive_mark_erased(${deps.tenantId}::uuid, ${prefix})`),
      );
    },

    async audit(entry: LegalEraseAuditEntry) {
      await deps.withTenant({ tenantId: deps.tenantId, userId: deps.operatorId }, (tx) =>
        writePlatformAudit(tx, {
          action: 'archive.erased',
          outcome: 'allow',
          actor: {
            operatorId: entry.operatorId,
            ip: null,
            userAgent: 'archive:legal-erase',
            requestId: null,
          },
          targetTenantId: deps.tenantId,
          reason: entry.reason,
          resourceType: 'tenant_archive',
          metadata: {
            phase: entry.phase,
            objects: entry.objects,
            versions: entry.versions,
            complete: entry.phase === 'done' || entry.phase === 'rerun',
            // Named by the person who ran the command: an attribution checked against the console, not
            // an approval (docs/runbooks/archive-release.md).
            namedSecondOperator: entry.approverId,
            prefix: entry.prefix,
          },
        }),
      );
    },
  };
}

import type { CreateSupportGrantRequest, SupportGrantDto } from '@consultorio/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { supportGrant } from '../../../db/schema/operator.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

export interface SupportGrants {
  list(tx: Tx): Promise<SupportGrantDto[]>;
  create(
    tx: Tx,
    input: { actor: AuditActor; userId: string; request: CreateSupportGrantRequest },
  ): Promise<SupportGrantDto>;
  /** Ends a grant now. A grant that already ended or does not exist is a 404. */
  revoke(tx: Tx, input: { actor: AuditActor; userId: string; grantId: string }): Promise<void>;
}

interface GrantRecord {
  id: string;
  reason: string;
  startsAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  /** The database clock: a grant is judged by the same `now()` the operator's policies use. */
  now: Date;
}

const COLUMNS = {
  id: supportGrant.id,
  reason: supportGrant.reason,
  startsAt: supportGrant.startsAt,
  expiresAt: supportGrant.expiresAt,
  revokedAt: supportGrant.revokedAt,
  now: sql<Date>`now()`.mapWith((value: string) => new Date(value)),
};

function toDto(row: GrantRecord): SupportGrantDto {
  const status = row.revokedAt
    ? 'revoked'
    : row.expiresAt <= row.now || row.startsAt > row.now
      ? 'expired'
      : 'active';
  return {
    id: row.id,
    reason: row.reason,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    status,
  };
}

/**
 * The organization's side of support access: it opens a time-boxed window for the platform, for a
 * stated reason, and can close it at any moment. The window never opens clinical data (the
 * operator's database role cannot read any), and every use appears in the organization's audit log.
 */
export function createSupportGrants(): SupportGrants {
  return {
    async list(tx) {
      const rows = await tx
        .select(COLUMNS)
        .from(supportGrant)
        .orderBy(desc(supportGrant.startsAt))
        .limit(100);
      return rows.map(toDto);
    },

    async create(tx, input) {
      const [row] = await tx
        .insert(supportGrant)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          reason: input.request.reason,
          grantedBy: input.userId,
          expiresAt: sql`now() + make_interval(hours => ${input.request.durationHours})`,
        })
        .returning(COLUMNS);
      if (!row) throw new Error('support grant insert returned no row');
      await audit(tx, {
        action: 'support.grant.created',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'support_grant',
        resourceId: row.id,
        metadata: { hours: input.request.durationHours },
      });
      return toDto(row);
    },

    async revoke(tx, input) {
      const [row] = await tx
        .update(supportGrant)
        .set({ revokedAt: sql`now()`, revokedBy: input.userId })
        .where(
          and(
            eq(supportGrant.id, input.grantId),
            isNull(supportGrant.revokedAt),
            sql`${supportGrant.expiresAt} > now()`,
          ),
        )
        .returning({ id: supportGrant.id });
      if (!row) throw new AppError('not_found');
      await audit(tx, {
        action: 'support.grant.revoked',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'support_grant',
        resourceId: row.id,
      });
    },
  };
}

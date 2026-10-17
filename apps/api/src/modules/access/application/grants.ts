import { type GrantablePermission } from '@consultorio/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { permissionGrant } from '../../../db/schema/access.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { GrantsRepo } from '../../../platform/authz/guard.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { evaluateGrant, isGrantable, scopeAllowedFor } from '../domain/grant-rules.js';

import { loadMember } from './members.js';
import { AccessRefused } from './refusal.js';

export interface GrantRecord {
  id: string;
  permission: GrantablePermission;
  scope: Record<string, unknown>;
  grantedBy: string;
  grantedAt: Date;
}

export interface GrantInput {
  actor: AuditActor & { userId: string };
  actorMembershipId: string;
  targetMembershipId: string;
  permission: string;
  scope?: { professionalIds: string[] } | undefined;
}

export interface Grants {
  list(tx: Tx, membershipId: string): Promise<GrantRecord[]>;
  grant(tx: Tx, input: GrantInput): Promise<GrantRecord>;
  revoke(
    tx: Tx,
    input: {
      actor: AuditActor;
      actorUserId: string;
      targetMembershipId: string;
      permission: string;
    },
  ): Promise<void>;
}

const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
}

export function createGrants(): Grants {
  return {
    async list(tx, membershipId) {
      const rows = await tx
        .select()
        .from(permissionGrant)
        .where(
          and(eq(permissionGrant.membershipId, membershipId), isNull(permissionGrant.revokedAt)),
        )
        .orderBy(asc(permissionGrant.createdAt), asc(permissionGrant.id));
      return rows.flatMap((row) =>
        isGrantable(row.permission)
          ? [
              {
                id: row.id,
                permission: row.permission,
                scope: row.scope,
                grantedBy: row.grantedBy,
                grantedAt: row.createdAt,
              },
            ]
          : [],
      );
    },

    async grant(tx, input) {
      const verdict = evaluateGrant({
        actorMembershipId: input.actorMembershipId,
        targetMembershipId: input.targetMembershipId,
        permission: input.permission,
      });
      if (!verdict.ok) throw new AccessRefused(`grant_${verdict.reason}`);
      // `evaluateGrant` narrowed the string to the fixed set.
      const permission = input.permission as GrantablePermission;

      const target = await loadMember(tx, input.targetMembershipId);
      if (!target) throw new AppError('not_found');
      if (target.status !== 'active') throw new AppError('conflict');
      if (!scopeAllowedFor(permission, input.scope)) {
        throw new AppError('validation_failed', [
          { path: 'scope', i18nKey: 'access.grant.scope_invalid' },
        ]);
      }

      try {
        const [row] = await tx
          .insert(permissionGrant)
          .values({
            tenantId: sql`current_setting('app.tenant_id')::uuid`,
            membershipId: target.id,
            permission,
            scope: input.scope ?? {},
            grantedBy: input.actor.userId,
          })
          .returning();
        if (!row) throw new Error('grant insert returned no row');
        await audit(tx, {
          action: 'permission.granted',
          outcome: 'allow',
          actor: input.actor,
          resourceType: 'membership',
          resourceId: target.id,
          metadata: { permission },
        });
        return {
          id: row.id,
          permission,
          scope: row.scope,
          grantedBy: row.grantedBy,
          grantedAt: row.createdAt,
        };
      } catch (error) {
        if (sqlState(error) === UNIQUE_VIOLATION) throw new AppError('conflict');
        throw error;
      }
    },

    async revoke(tx, input) {
      const target = await loadMember(tx, input.targetMembershipId);
      if (!target) throw new AppError('not_found');
      const revoked = await tx
        .update(permissionGrant)
        .set({ revokedAt: new Date(), revokedBy: input.actorUserId })
        .where(
          and(
            eq(permissionGrant.membershipId, target.id),
            eq(permissionGrant.permission, input.permission),
            isNull(permissionGrant.revokedAt),
          ),
        )
        .returning({ id: permissionGrant.id });
      if (revoked.length === 0) throw new AppError('not_found');
      await audit(tx, {
        action: 'permission.revoked',
        outcome: 'allow',
        actor: input.actor,
        resourceType: 'membership',
        resourceId: target.id,
        metadata: { permission: input.permission },
      });
    },
  };
}

/**
 * The grants of a member, read fresh on every request so a revocation takes effect with the next
 * call. It feeds the actor loader of the authorization engine; any failure there counts as "no
 * grants" (the loader catches it), so roles alone decide.
 */
export function createGrantsRepo(withTenant: WithTenant, grants: Grants): GrantsRepo {
  return {
    grantsFor: (tenantId, membershipId) =>
      withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
        const live = await grants.list(tx, membershipId);
        return live.map((grant) => grant.permission);
      }),
  };
}

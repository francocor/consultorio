import type { Role, SessionScope } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { primaryRole } from '../../../platform/http/auth-guard.js';
import type { PasswordHasher } from '../infrastructure/argon2.js';

import type { IssuedSession, SessionService } from './sessions.js';

export interface LoginDeps {
  withTenant: WithTenant;
  hasher: PasswordHasher;
  sessions: SessionService;
  clock?: () => Date;
}

export interface LoginInput {
  tenantId: string;
  email: string;
  password: string;
  /** Origin of the request: address, user agent and request id. */
  actor: AuditActor;
  /** The session cookie the request came with, if any. It is replaced, never reused. */
  previousToken?: string | null;
}

export type LoginOutcome =
  { kind: 'session'; issued: IssuedSession; scope: SessionScope } | { kind: 'failed' };

export type LoginFailureReason = 'bad_credentials' | 'inactive_membership';

interface Candidate {
  userId: string;
  passwordHash: string;
  membershipId: string;
  membershipActive: boolean;
  roles: readonly Role[];
}

/** One call, one outcome. Every failure looks the same to the caller; the audit says why. */
export interface LoginService {
  login(input: LoginInput): Promise<LoginOutcome>;
}

interface AccountRow extends Record<string, unknown> {
  id: string;
  password_hash: string;
}

/**
 * Finds the account and its membership on this tenant. Read only, in a short transaction of its
 * own, so no database connection is held while the (slow) password hash is computed.
 */
async function findCandidate(
  withTenant: WithTenant,
  tenantId: string,
  email: string,
): Promise<Candidate | null> {
  return withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const found = await tx.execute<AccountRow>(
      sql`select id, password_hash from app.lookup_user_for_login(${email})`,
    );
    const account = found.rows[0];
    if (!account) return null;
    const [member] = await tx
      .select({ id: membership.id, status: membership.status, roles: membership.roles })
      .from(membership)
      .where(and(eq(membership.tenantId, tenantId), eq(membership.userId, account.id)));
    if (!member) return null;
    return {
      userId: account.id,
      passwordHash: account.password_hash,
      membershipId: member.id,
      membershipActive: member.status === 'active',
      roles: member.roles as Role[],
    };
  });
}

export function createLoginService(deps: LoginDeps): LoginService {
  const clock = deps.clock ?? (() => new Date());

  async function recordFailure(
    tx: Tx,
    input: LoginInput,
    candidate: Candidate | null,
    reason: LoginFailureReason,
  ): Promise<void> {
    await audit(tx, {
      action: 'auth.login.failed',
      outcome: 'deny',
      actor: { ...input.actor, userId: candidate?.userId ?? null, actingRole: null },
      reason,
    });
  }

  return {
    async login(input) {
      const email = input.email.trim();
      const candidate = await findCandidate(deps.withTenant, input.tenantId, email);

      // Exactly one Argon2 verification whether or not the account exists on this tenant.
      const passwordMatches = await deps.hasher.verifyOrDummy(
        candidate?.passwordHash,
        input.password,
      );

      const actingUser = candidate?.userId ?? SYSTEM_USER_ID;
      return deps.withTenant({ tenantId: input.tenantId, userId: actingUser }, async (tx) => {
        if (!candidate || !passwordMatches) {
          await recordFailure(tx, input, candidate, 'bad_credentials');
          return { kind: 'failed' };
        }
        if (!candidate.membershipActive) {
          await recordFailure(tx, input, candidate, 'inactive_membership');
          return { kind: 'failed' };
        }

        const now = clock();
        await tx
          .update(userAccount)
          .set({
            // The first successful sign-in starts the two-factor grace period.
            firstSignInAt: sql`coalesce(${userAccount.firstSignInAt}, ${now.toISOString()}::timestamptz)`,
            failedLogins: 0,
            lastFailedAt: null,
            lockedUntil: null,
          })
          .where(eq(userAccount.id, candidate.userId));

        // A new sign-in replaces the session of the cookie it came with.
        if (input.previousToken) {
          const previous = await deps.sessions.resolve(tx, input.previousToken);
          if (previous) await deps.sessions.revoke(tx, previous.sessionId, 'rotated');
        }

        const scope: SessionScope = 'full';
        const issued = await deps.sessions.issue(tx, {
          tenantId: input.tenantId,
          userId: candidate.userId,
          membershipId: candidate.membershipId,
          scope,
          ip: input.actor.ip,
          userAgent: input.actor.userAgent,
        });
        await audit(tx, {
          action: 'auth.login.success',
          outcome: 'allow',
          actor: {
            ...input.actor,
            userId: candidate.userId,
            actingRole: primaryRole(candidate.roles),
          },
          resourceType: 'session',
          resourceId: issued.sessionId,
        });
        return { kind: 'session', issued, scope };
      });
    },
  };
}

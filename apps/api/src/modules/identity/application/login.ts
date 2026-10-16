import type { Role, SessionScope } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';

import { membership, userAccount } from '../../../db/schema/identity.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { primaryRole } from '../../../platform/http/auth-guard.js';
import { clientKeyOf } from '../../../platform/http/rate-limit.js';
import type { PasswordHasher } from '../infrastructure/argon2.js';

import type { AttemptThrottle } from './attempt-throttle.js';
import type { Charge, Lockout } from './lockout.js';
import { createLoginChallenge } from './second-factor-login.js';
import type { IssuedSession, SessionService } from './sessions.js';
import { twoFactorRequirement } from './two-factor-policy.js';
import type { TwoFactor } from './two-factor.js';

export interface LoginDeps {
  withTenant: WithTenant;
  hasher: PasswordHasher;
  sessions: SessionService;
  lockout: Lockout;
  twoFactor: TwoFactor;
  /** Failures of identifiers that have no account on the tenant: they get the same delays. */
  accountThrottle: AttemptThrottle;
  /** Failures per client address. */
  clientThrottle: AttemptThrottle;
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
  | { kind: 'session'; issued: IssuedSession; scope: SessionScope }
  /** The password was right and a second factor is needed: the client sends this challenge back. */
  | { kind: 'challenge'; challenge: string }
  | { kind: 'failed' };

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
  const { lockout } = deps;
  const clock = deps.clock ?? (() => new Date());

  async function recordFailure(
    tx: Tx,
    input: LoginInput,
    candidate: Candidate | null,
    reason: LoginFailureReason,
  ): Promise<void> {
    if (candidate) {
      await lockout.recordFailure(tx, candidate.userId, 'password', input.actor, {
        charged: true,
      });
    }
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
      const clientKey = clientKeyOf(input.actor.ip ?? 'unknown');
      const identifierKey = `${input.tenantId}|${email.toLowerCase()}`;
      const candidate = await findCandidate(deps.withTenant, input.tenantId, email);

      // 1. The gate. Nothing about the password is looked at until the attempt is allowed.
      let allowed = !deps.clientThrottle.check(clientKey).blocked;
      let charge: Charge | null = null;
      if (allowed && candidate) {
        const reservation = await deps.withTenant(
          { tenantId: input.tenantId, userId: candidate.userId },
          (tx) => lockout.reserveAttempt(tx, candidate.userId, input.actor),
        );
        allowed = reservation.kind === 'proceed';
        if (reservation.kind === 'proceed') charge = reservation.charge;
      } else if (allowed) {
        allowed = !deps.accountThrottle.check(identifierKey).blocked;
      }

      // 2. Exactly one Argon2 verification on every path, so timing does not tell the paths apart.
      // A refused attempt verifies against a dummy hash and can never succeed.
      const passwordMatches = await deps.hasher.verifyOrDummy(
        allowed ? candidate?.passwordHash : null,
        input.password,
      );
      if (!allowed) return { kind: 'failed' };

      // 3. The verdict.
      const actingUser = candidate?.userId ?? SYSTEM_USER_ID;
      return deps.withTenant({ tenantId: input.tenantId, userId: actingUser }, async (tx) => {
        if (!candidate || !passwordMatches) {
          if (!candidate) deps.accountThrottle.recordFailure(identifierKey);
          deps.clientThrottle.recordFailure(clientKey);
          await recordFailure(tx, input, candidate, 'bad_credentials');
          return { kind: 'failed' };
        }
        if (!candidate.membershipActive) {
          deps.clientThrottle.recordFailure(clientKey);
          await recordFailure(tx, input, candidate, 'inactive_membership');
          return { kind: 'failed' };
        }

        // The password is right. What the second factor asks of this user depends on the role, the
        // grace period (counted from the first sign-in) and the organization's setting.
        const now = clock();
        const [account] = await tx
          .select({ firstSignInAt: userAccount.firstSignInAt })
          .from(userAccount)
          .where(eq(userAccount.id, candidate.userId));
        const [organization] = await tx.select({ settings: tenant.settings }).from(tenant);
        const enrolled = (await deps.twoFactor.status(tx, candidate.userId)).enrolled;
        const requirement = twoFactorRequirement({
          roles: candidate.roles,
          enrolled,
          firstSignInAt: account?.firstSignInAt ?? null,
          organizationRequires: organization?.settings['require_2fa'] === true,
          now,
        });

        // The first successful password check starts the grace period.
        await tx
          .update(userAccount)
          .set({
            firstSignInAt: sql`coalesce(${userAccount.firstSignInAt}, ${now.toISOString()}::timestamptz)`,
          })
          .where(eq(userAccount.id, candidate.userId));

        if (requirement.kind === 'challenge') {
          // Not signed in yet. Give the attempt back (the password was right) but keep earlier
          // failures: a wrong code will count toward the lock.
          await lockout.refundAttempt(tx, candidate.userId, charge);
          const challenge = await createLoginChallenge(tx, {
            tenantId: input.tenantId,
            userId: candidate.userId,
            membershipId: candidate.membershipId,
            now,
          });
          return { kind: 'challenge', challenge };
        }
        await lockout.reset(tx, candidate.userId);

        // A new sign-in replaces the session of the cookie it came with.
        if (input.previousToken) {
          const previous = await deps.sessions.resolve(tx, input.previousToken);
          if (previous) await deps.sessions.revoke(tx, previous.sessionId, 'rotated');
        }

        // Past the grace period without a factor: the session only reaches the enrollment endpoints.
        const scope: SessionScope =
          requirement.kind === 'enrollment_required' ? 'two_factor_enrollment' : 'full';
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

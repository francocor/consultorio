import { createHash, randomBytes } from 'node:crypto';

import type { Role } from '@consultorio/contracts';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import { loginChallenge, membership } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx, type WithTenant } from '../../../platform/db/tenant-context.js';
import { primaryRole } from '../../../platform/http/auth-guard.js';
import { clientKeyOf } from '../../../platform/http/rate-limit.js';

import type { AttemptThrottle } from './attempt-throttle.js';
import type { Lockout } from './lockout.js';
import type { LoginOutcome } from './login.js';
import type { SessionService } from './sessions.js';
import type { TwoFactor } from './two-factor.js';

/** A challenge lives five minutes and allows five attempts (design 5.1). */
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const CHALLENGE_MAX_ATTEMPTS = 5;

function hashChallenge(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Opens the step between a right password and the second factor. The raw challenge goes to the
 * client once; only its hash is stored.
 */
export async function createLoginChallenge(
  tx: Tx,
  input: { tenantId: string; userId: string; membershipId: string; now: Date },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await tx.insert(loginChallenge).values({
    tenantId: input.tenantId,
    userId: input.userId,
    membershipId: input.membershipId,
    tokenHash: hashChallenge(token),
    expiresAt: new Date(input.now.getTime() + CHALLENGE_TTL_MS),
  });
  return token;
}

export interface SecondFactorLoginDeps {
  withTenant: WithTenant;
  twoFactor: TwoFactor;
  lockout: Lockout;
  sessions: SessionService;
  clientThrottle: AttemptThrottle;
  clock?: () => Date;
}

export interface SecondFactorInput {
  tenantId: string;
  challenge: string;
  code?: string;
  recoveryCode?: string;
  actor: AuditActor;
  previousToken?: string | null;
}

export interface SecondFactorLogin {
  verify(input: SecondFactorInput): Promise<LoginOutcome>;
}

type FailureReason =
  | 'invalid_challenge'
  | 'challenge_exhausted'
  | 'inactive_membership'
  | 'invalid'
  | 'replay'
  | 'recovery_invalid';

/**
 * Second step of a sign-in. Every failure is the same `failed` outcome (a 401 with the generic
 * body); the audit entry says which it was. A wrong or reused code counts toward the SAME lock as
 * a wrong password, the lock is checked before the code is looked at, and each attempt is charged
 * to the challenge before it is verified so parallel guesses cannot exceed the five allowed.
 */
export function createSecondFactorLogin(deps: SecondFactorLoginDeps): SecondFactorLogin {
  const clock = deps.clock ?? (() => new Date());

  return {
    async verify(input) {
      const clientKey = clientKeyOf(input.actor.ip ?? 'unknown');
      const failed: LoginOutcome = { kind: 'failed' };
      if (deps.clientThrottle.check(clientKey).blocked) return failed;

      const hash = hashChallenge(input.challenge);
      const found = await deps.withTenant(
        { tenantId: input.tenantId, userId: SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              id: loginChallenge.id,
              userId: loginChallenge.userId,
              membershipId: loginChallenge.membershipId,
            })
            .from(loginChallenge)
            .where(eq(loginChallenge.tokenHash, hash));
          return row ?? null;
        },
      );

      if (!found) {
        deps.clientThrottle.recordFailure(clientKey);
        await deps.withTenant({ tenantId: input.tenantId, userId: SYSTEM_USER_ID }, (tx) =>
          audit(tx, {
            action: 'auth.2fa.failed',
            outcome: 'deny',
            actor: { ...input.actor, userId: null, actingRole: null },
            reason: 'invalid_challenge' satisfies FailureReason,
          }),
        );
        return failed;
      }

      const outcome = await deps.withTenant(
        { tenantId: input.tenantId, userId: found.userId },
        async (tx): Promise<LoginOutcome> => {
          const now = clock();
          const actor: AuditActor = { ...input.actor, userId: found.userId, actingRole: null };
          const fail = async (reason: FailureReason, counts: boolean): Promise<LoginOutcome> => {
            if (counts) await deps.lockout.recordFailure(tx, found.userId, 'second_factor', actor);
            await audit(tx, { action: 'auth.2fa.failed', outcome: 'deny', actor, reason });
            return failed;
          };

          // 1. The lock and the backoff come first: nothing about the code is looked at while locked.
          const gate = await deps.lockout.checkGate(tx, found.userId, input.actor);
          if (gate.kind !== 'proceed') return failed;

          // 2. Charge the attempt to the challenge, atomically. Dead, used or exhausted: refused.
          const claimed = await tx
            .update(loginChallenge)
            .set({ attempts: sql`${loginChallenge.attempts} + 1` })
            .where(
              and(
                eq(loginChallenge.id, found.id),
                isNull(loginChallenge.consumedAt),
                gt(loginChallenge.expiresAt, now),
                lt(loginChallenge.attempts, CHALLENGE_MAX_ATTEMPTS),
              ),
            )
            .returning({ id: loginChallenge.id });
          if (claimed.length === 0) return fail('challenge_exhausted', false);

          const [member] = await tx
            .select({ status: membership.status, roles: membership.roles })
            .from(membership)
            .where(
              and(eq(membership.tenantId, input.tenantId), eq(membership.id, found.membershipId)),
            );
          if (member?.status !== 'active') return fail('inactive_membership', false);

          // 3. The second factor itself.
          let usedRecovery = false;
          if (input.recoveryCode !== undefined) {
            usedRecovery = await deps.twoFactor.useRecoveryCode(
              tx,
              found.userId,
              input.recoveryCode,
            );
            if (!usedRecovery) return fail('recovery_invalid', true);
          } else {
            const verdict = await deps.twoFactor.verifyCode(tx, {
              tenantId: input.tenantId,
              userId: found.userId,
              code: input.code ?? '',
            });
            if (!verdict.ok) return fail(verdict.reason, true);
          }

          // 4. Success: spend the challenge, forget the failures, replace the old session.
          await tx
            .update(loginChallenge)
            .set({ consumedAt: now })
            .where(eq(loginChallenge.id, found.id));
          await deps.lockout.reset(tx, found.userId);
          if (input.previousToken) {
            const previous = await deps.sessions.resolve(tx, input.previousToken);
            if (previous) await deps.sessions.revoke(tx, previous.sessionId, 'rotated');
          }
          const issued = await deps.sessions.issue(tx, {
            tenantId: input.tenantId,
            userId: found.userId,
            membershipId: found.membershipId,
            scope: 'full',
            ip: input.actor.ip,
            userAgent: input.actor.userAgent,
          });
          const acting = { ...actor, actingRole: primaryRole(member.roles as Role[]) };
          await audit(tx, {
            action: usedRecovery ? 'auth.2fa.recovery_used' : 'auth.2fa.verified',
            outcome: 'allow',
            actor: acting,
          });
          await audit(tx, {
            action: 'auth.login.success',
            outcome: 'allow',
            actor: acting,
            resourceType: 'session',
            resourceId: issued.sessionId,
          });
          return { kind: 'session', issued, scope: 'full' };
        },
      );

      if (outcome.kind === 'failed') deps.clientThrottle.recordFailure(clientKey);
      return outcome;
    },
  };
}

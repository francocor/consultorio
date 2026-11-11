import { createHash, randomBytes } from 'node:crypto';

import type { OperatorLoginRequest } from '@consultorio/contracts';
import { and, eq, isNull } from 'drizzle-orm';

import { operatorSession, operatorUser } from '../../../db/schema/operator.js';
import {
  writePlatformAudit,
  type PlatformAuditActor,
} from '../../../platform/audit/platform-audit.js';
import { verifyTotp, type TotpVerdict } from '../../../platform/crypto/totp.js';
import { AppError } from '../../../platform/http/problem.js';
import type { PasswordHasher } from '../../identity/index.js';
import type { OperatorSecrets } from '../infrastructure/secrets.js';

import type { OperatorIdentity, OperatorRun } from './context.js';

/** An operator session ends after 30 minutes without use and after 8 hours whatever the use. */
export const OPERATOR_SESSION_IDLE_MS = 30 * 60_000;
export const OPERATOR_SESSION_ABSOLUTE_MS = 8 * 3_600_000;
/** Consecutive failures (wrong password or wrong code) that lock the account. */
export const OPERATOR_MAX_FAILURES = 5;
export const OPERATOR_LOCK_MS = 15 * 60_000;

const TOUCH_AFTER_MS = 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function hashOperatorToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OperatorSessionInfo {
  sessionId: string;
  operator: OperatorIdentity;
  expiresAt: Date;
}

export interface OperatorAuth {
  /**
   * Password and second-factor code in one step: an operator is never half signed in, and the
   * second factor has no grace period. EVERY way of failing (unknown address, disabled or locked
   * account, wrong password, wrong or replayed code) answers the same `unauthenticated`.
   */
  login(
    input: OperatorLoginRequest,
    meta: Omit<PlatformAuditActor, 'operatorId'>,
  ): Promise<OperatorSessionInfo & { token: string }>;
  /** The live session behind a cookie token, or null. */
  resolve(token: string): Promise<OperatorSessionInfo | null>;
  logout(session: OperatorSessionInfo, meta: Omit<PlatformAuditActor, 'operatorId'>): Promise<void>;
}

export interface OperatorAuthDeps {
  run: OperatorRun;
  hasher: PasswordHasher;
  secrets: OperatorSecrets;
  clock?: () => Date;
}

type LoginOutcome = { ok: false } | { ok: true; info: OperatorSessionInfo; token: string };

export function createOperatorAuth(deps: OperatorAuthDeps): OperatorAuth {
  const clock = deps.clock ?? (() => new Date());

  return {
    async login(input, meta) {
      const now = clock();
      const outcome = await deps.run({}, async (tx): Promise<LoginOutcome> => {
        const [operator] = await tx
          .select()
          .from(operatorUser)
          .where(eq(operatorUser.email, input.email))
          .for('update');

        if (operator?.status !== 'active') {
          // Same work as a real account, so the answer takes the same time.
          await deps.hasher.verifyOrDummy(null, input.password);
          await writePlatformAudit(tx, {
            action: 'operator.login.failed',
            outcome: 'deny',
            actor: { ...meta, operatorId: null },
            reason: 'unknown_or_disabled',
          });
          return { ok: false };
        }

        const actor = { ...meta, operatorId: operator.id };
        const lockActive = operator.lockedUntil !== null && operator.lockedUntil > now;
        if (lockActive) {
          // A locked account must not answer faster than one that is being checked: the time
          // would tell an attacker that the address exists and has been hammered.
          await deps.hasher.verifyOrDummy(null, input.password);
          await writePlatformAudit(tx, {
            action: 'operator.login.locked',
            outcome: 'deny',
            actor,
            reason: 'account_locked',
          });
          return { ok: false };
        }

        const passwordOk = await deps.hasher.verify(operator.passwordHash, input.password);
        let totp: TotpVerdict = { ok: false, reason: 'invalid' };
        try {
          const secret = await deps.secrets.open(operator.id, {
            dekWrapped: operator.totpDekWrapped,
            encrypted: operator.totpSecretEnc,
          });
          totp = verifyTotp(secret, input.code, now, operator.totpLastStep);
        } catch {
          // A secret that cannot be opened is a failed second factor, never a way in.
        }

        if (!passwordOk || !totp.ok) {
          // A lock that has run out starts the count afresh.
          const previous = operator.lockedUntil === null ? operator.failedLogins : 0;
          const failures = previous + 1;
          const locks = failures >= OPERATOR_MAX_FAILURES;
          await tx
            .update(operatorUser)
            .set({
              failedLogins: failures,
              lastFailedAt: now,
              lockedUntil: locks ? new Date(now.getTime() + OPERATOR_LOCK_MS) : null,
            })
            .where(eq(operatorUser.id, operator.id));
          await writePlatformAudit(tx, {
            action: 'operator.login.failed',
            outcome: 'deny',
            actor,
            reason: 'bad_credentials',
            metadata: { failures },
          });
          if (locks) {
            await writePlatformAudit(tx, {
              action: 'operator.login.locked',
              outcome: 'deny',
              actor,
              reason: 'too_many_failures',
              metadata: { lockMinutes: Math.round(OPERATOR_LOCK_MS / 60_000) },
            });
          }
          return { ok: false };
        }

        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(now.getTime() + OPERATOR_SESSION_ABSOLUTE_MS);
        const [created] = await tx
          .insert(operatorSession)
          .values({
            operatorId: operator.id,
            tokenHash: hashOperatorToken(token),
            ip: meta.ip,
            userAgent: meta.userAgent,
            lastSeenAt: now,
            expiresAt,
          })
          .returning({ id: operatorSession.id });
        if (!created) throw new Error('operator session insert returned no row');
        await tx
          .update(operatorUser)
          .set({ failedLogins: 0, lastFailedAt: null, lockedUntil: null, totpLastStep: totp.step })
          .where(eq(operatorUser.id, operator.id));
        await writePlatformAudit(tx, {
          action: 'operator.login.success',
          outcome: 'allow',
          actor,
          resourceType: 'operator_session',
          resourceId: created.id,
        });
        return {
          ok: true,
          token,
          info: {
            sessionId: created.id,
            expiresAt,
            operator: {
              id: operator.id,
              email: operator.email,
              displayName: operator.displayName,
            },
          },
        };
      });

      // The failures above are recorded and committed; only now does the caller hear "no".
      if (!outcome.ok) throw new AppError('unauthenticated');
      return { ...outcome.info, token: outcome.token };
    },

    async resolve(token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      const now = clock();
      return deps.run({}, async (tx) => {
        const [row] = await tx
          .select({
            sessionId: operatorSession.id,
            lastSeenAt: operatorSession.lastSeenAt,
            expiresAt: operatorSession.expiresAt,
            revokedAt: operatorSession.revokedAt,
            operatorId: operatorUser.id,
            email: operatorUser.email,
            displayName: operatorUser.displayName,
            status: operatorUser.status,
          })
          .from(operatorSession)
          .innerJoin(operatorUser, eq(operatorUser.id, operatorSession.operatorId))
          .where(eq(operatorSession.tokenHash, hashOperatorToken(token)));

        if (!row || row.status !== 'active' || row.revokedAt !== null) return null;
        if (now >= row.expiresAt) return null;
        if (now.getTime() - row.lastSeenAt.getTime() >= OPERATOR_SESSION_IDLE_MS) return null;

        if (now.getTime() - row.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
          await tx
            .update(operatorSession)
            .set({ lastSeenAt: now })
            .where(eq(operatorSession.id, row.sessionId));
        }
        return {
          sessionId: row.sessionId,
          expiresAt: row.expiresAt,
          operator: { id: row.operatorId, email: row.email, displayName: row.displayName },
        };
      });
    },

    async logout(session, meta) {
      await deps.run({ operatorId: session.operator.id }, async (tx) => {
        await tx
          .update(operatorSession)
          .set({ revokedAt: clock(), revokedReason: 'logout' })
          .where(and(eq(operatorSession.id, session.sessionId), isNull(operatorSession.revokedAt)));
        await writePlatformAudit(tx, {
          action: 'operator.logout',
          outcome: 'allow',
          actor: { ...meta, operatorId: session.operator.id },
          resourceType: 'operator_session',
          resourceId: session.sessionId,
        });
      });
    },
  };
}

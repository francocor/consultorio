import { eq, sql } from 'drizzle-orm';

import { userAccount } from '../../../db/schema/identity.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

export interface LockoutPolicy {
  /** Consecutive failures that lock the account. */
  maxFailures: number;
  lockMs: number;
}

/** 10 consecutive failures lock the account for 15 minutes (identity-access, ADR-004). */
export const DEFAULT_LOCKOUT: LockoutPolicy = { maxFailures: 10, lockMs: 15 * 60_000 };

const FREE_FAILURES = 2;
const BACKOFF_STEP_MS = 1000;
const BACKOFF_CAP_MS = 5 * 60_000;

/**
 * How long the next attempt must wait after `failures` consecutive failures: nothing for the
 * first `freeFailures` (two by default), then 1 s, 2 s, 4 s ... doubling, capped at five minutes.
 */
export function backoffMs(failures: number, freeFailures = FREE_FAILURES): number {
  if (failures <= freeFailures) return 0;
  const exponent = Math.min(failures - freeFailures - 1, 30);
  return Math.min(BACKOFF_STEP_MS * 2 ** exponent, BACKOFF_CAP_MS);
}

export interface LockState {
  failedLogins: number;
  lastFailedAt: Date | null;
  lockedUntil: Date | null;
}

/**
 * When the lock ends, or null if there is none. A counter at the limit with no recorded lock
 * (an attempt that crashed before it could write one) counts as locked from the last failure, so
 * an account can never be left permanently locked or permanently open by a half-finished attempt.
 */
export function effectiveLockEnd(state: LockState, policy = DEFAULT_LOCKOUT): Date | null {
  if (state.lockedUntil !== null) return state.lockedUntil;
  if (state.failedLogins >= policy.maxFailures && state.lastFailedAt !== null) {
    return new Date(state.lastFailedAt.getTime() + policy.lockMs);
  }
  return null;
}

export type GateDecision =
  | { kind: 'locked'; until: Date }
  | { kind: 'throttled'; retryAt: Date }
  /** `expiredLock`: a lock was in force and its window is over, so the counters start afresh. */
  | { kind: 'open'; expiredLock: boolean };

/** Whether an attempt may be evaluated at all. The password is never looked at before this. */
export function gateDecision(state: LockState, now: Date, policy = DEFAULT_LOCKOUT): GateDecision {
  const lockEnd = effectiveLockEnd(state, policy);
  if (lockEnd !== null) {
    return now.getTime() < lockEnd.getTime()
      ? { kind: 'locked', until: lockEnd }
      : { kind: 'open', expiredLock: true };
  }
  if (state.lastFailedAt !== null) {
    const retryAt = new Date(state.lastFailedAt.getTime() + backoffMs(state.failedLogins));
    if (now.getTime() < retryAt.getTime()) return { kind: 'throttled', retryAt };
  }
  return { kind: 'open', expiredLock: false };
}

/** What kind of credential failed. A wrong second factor counts exactly like a wrong password. */
export type FailureKind = 'password' | 'second_factor';

export type Reservation = { kind: 'proceed' } | { kind: 'locked' } | { kind: 'throttled' };

export interface Lockout {
  /**
   * Checks the gate and, if the attempt may go on, charges it to the account BEFORE the password
   * is verified. Charging first makes parallel guesses count immediately, so a burst of requests
   * cannot test more passwords than the limit allows.
   */
  reserveAttempt(tx: Tx, userId: string, actor: AuditActor): Promise<Reservation>;
  /**
   * Gate only, for a step that continues a sign-in (the second factor): refuses while locked or
   * throttled, charges nothing.
   */
  checkGate(tx: Tx, userId: string, actor: AuditActor): Promise<Reservation>;
  /**
   * A failed credential. `charged` says the attempt was already counted by `reserveAttempt`
   * (the password); a second-factor failure is counted here. Locks the account when the limit is
   * reached and audits the lock.
   */
  recordFailure(
    tx: Tx,
    userId: string,
    kind: FailureKind,
    actor: AuditActor,
    options?: { charged?: boolean },
  ): Promise<{ locked: boolean }>;
  /** A sign-in that needs a second factor: the password was right, so give the charge back. */
  refundAttempt(tx: Tx, userId: string): Promise<void>;
  /** A completed sign-in: forget the failures. */
  reset(tx: Tx, userId: string): Promise<void>;
}

export function createLockout(
  options: { policy?: LockoutPolicy; clock?: () => Date } = {},
): Lockout {
  const policy = options.policy ?? DEFAULT_LOCKOUT;
  const clock = options.clock ?? (() => new Date());

  /** Reads the account's counters and holds its row until the transaction ends. */
  async function lockRow(tx: Tx, userId: string): Promise<LockState | null> {
    const [row] = await tx
      .select({
        failedLogins: userAccount.failedLogins,
        lastFailedAt: userAccount.lastFailedAt,
        lockedUntil: userAccount.lockedUntil,
      })
      .from(userAccount)
      .where(eq(userAccount.id, userId))
      .for('update');
    return row ?? null;
  }

  async function gate(
    tx: Tx,
    userId: string,
    actor: AuditActor,
    charge: boolean,
  ): Promise<Reservation> {
    const state = await lockRow(tx, userId);
    if (!state) return { kind: 'locked' };
    const now = clock();
    const decision = gateDecision(state, now, policy);

    if (decision.kind === 'locked') {
      await audit(tx, {
        action: 'auth.login.locked',
        outcome: 'deny',
        actor: { ...actor, userId, actingRole: null },
        reason: 'account_locked',
      });
      return { kind: 'locked' };
    }
    if (decision.kind === 'throttled') return { kind: 'throttled' };

    let failures = state.failedLogins;
    if (decision.expiredLock) {
      failures = 0;
      await audit(tx, {
        action: 'auth.account.unlocked',
        outcome: 'allow',
        actor: { ...actor, userId, actingRole: null },
        reason: 'lock_expired',
      });
    }
    if (charge) {
      await tx
        .update(userAccount)
        .set({ failedLogins: failures + 1, lastFailedAt: now, lockedUntil: null })
        .where(eq(userAccount.id, userId));
    } else if (decision.expiredLock) {
      await tx
        .update(userAccount)
        .set({ failedLogins: 0, lastFailedAt: null, lockedUntil: null })
        .where(eq(userAccount.id, userId));
    }
    return { kind: 'proceed' };
  }

  return {
    reserveAttempt: (tx, userId, actor) => gate(tx, userId, actor, true),
    checkGate: (tx, userId, actor) => gate(tx, userId, actor, false),

    async recordFailure(tx, userId, kind, actor, failureOptions = {}) {
      const state = await lockRow(tx, userId);
      if (!state) return { locked: false };
      const now = clock();

      let failedLogins = state.failedLogins;
      if (!(failureOptions.charged ?? false)) {
        failedLogins += 1;
        await tx
          .update(userAccount)
          .set({ failedLogins, lastFailedAt: now })
          .where(eq(userAccount.id, userId));
      }

      const alreadyLocked =
        state.lockedUntil !== null && state.lockedUntil.getTime() > now.getTime();
      if (failedLogins < policy.maxFailures || alreadyLocked) return { locked: alreadyLocked };

      const lockedUntil = new Date(now.getTime() + policy.lockMs);
      await tx.update(userAccount).set({ lockedUntil }).where(eq(userAccount.id, userId));
      await audit(tx, {
        action: 'auth.account.locked',
        outcome: 'deny',
        actor: { ...actor, userId, actingRole: null },
        reason: kind === 'password' ? 'password_failures' : 'second_factor_failures',
        metadata: { failures: failedLogins, lockMinutes: Math.round(policy.lockMs / 60_000) },
      });
      return { locked: true };
    },

    async refundAttempt(tx, userId) {
      await tx
        .update(userAccount)
        .set({ failedLogins: sql`greatest(${userAccount.failedLogins} - 1, 0)` })
        .where(eq(userAccount.id, userId));
    },

    async reset(tx, userId) {
      await tx
        .update(userAccount)
        .set({ failedLogins: 0, lastFailedAt: null, lockedUntil: null })
        .where(eq(userAccount.id, userId));
    },
  };
}

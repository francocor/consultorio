import { backoffMs } from './lockout.js';

export interface AttemptThrottleOptions {
  /** Failures tolerated before delays start. Accounts use 2; a shared client address more. */
  freeFailures?: number;
  /** Failures that lock the key outright. Leave unset for a key that is only ever delayed. */
  lockAfter?: number;
  lockMs?: number;
  /** Failures older than this are forgotten. */
  forgetAfterMs?: number;
  /** Most keys remembered at once; the least recently used is dropped beyond it. */
  maxKeys?: number;
  clock?: () => Date;
}

export interface AttemptThrottle {
  /** `blocked` means: do not even look at the credentials. */
  check(key: string): { blocked: boolean };
  recordFailure(key: string): void;
  reset(key: string): void;
}

interface Entry {
  failures: number;
  lastAt: number;
}

/**
 * In-memory counter of failed attempts per key, with the same delay schedule as a real account.
 *
 * Two uses. For identifiers that have NO account on the tenant, it makes repeated guesses meet
 * the same delays and the same lock as a real account would, so throttling cannot be used to
 * find out which emails exist (identity-access, "Lock does not leak existence"). And per client
 * address, where it only delays (a clinic shares one address). State is per process; the
 * authoritative lock of a real account lives in the database.
 */
export function createAttemptThrottle(options: AttemptThrottleOptions = {}): AttemptThrottle {
  const freeFailures = options.freeFailures ?? 2;
  const lockMs = options.lockMs ?? 15 * 60_000;
  const forgetAfterMs = options.forgetAfterMs ?? 30 * 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  const clock = options.clock ?? (() => new Date());
  const entries = new Map<string, Entry>();

  const lockedEnd = (entry: Entry): number | null =>
    options.lockAfter !== undefined && entry.failures >= options.lockAfter
      ? entry.lastAt + lockMs
      : null;

  return {
    check(key) {
      const entry = entries.get(key);
      if (!entry) return { blocked: false };
      const now = clock().getTime();

      const lockEnd = lockedEnd(entry);
      if (lockEnd !== null) {
        if (now < lockEnd) return { blocked: true };
        entries.delete(key);
        return { blocked: false };
      }
      if (now - entry.lastAt > forgetAfterMs) {
        entries.delete(key);
        return { blocked: false };
      }
      return { blocked: now < entry.lastAt + backoffMs(entry.failures, freeFailures) };
    },

    recordFailure(key) {
      const now = clock().getTime();
      const known = entries.get(key);
      const forgotten =
        known !== undefined && lockedEnd(known) === null && now - known.lastAt > forgetAfterMs;
      const failures = known && !forgotten ? known.failures + 1 : 1;
      // Re-inserting keeps least-recently-used order, so eviction drops the idlest key.
      entries.delete(key);
      entries.set(key, { failures, lastAt: now });
      while (entries.size > maxKeys) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    reset(key) {
      entries.delete(key);
    },
  };
}

import { describe, expect, it } from 'vitest';

import { DEFAULT_LOCKOUT, backoffMs, effectiveLockEnd, gateDecision } from './lockout.js';

const T0 = new Date('2026-10-16T09:00:00.000Z');
const after = (ms: number) => new Date(T0.getTime() + ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('defaults', () => {
  it('lock after 10 consecutive failures for 15 minutes', () => {
    expect(DEFAULT_LOCKOUT).toEqual({ maxFailures: 10, lockMs: 15 * MINUTE });
  });
});

describe('backoff schedule', () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 1 * SECOND],
    [4, 2 * SECOND],
    [5, 4 * SECOND],
    [6, 8 * SECOND],
    [7, 16 * SECOND],
    [8, 32 * SECOND],
    [9, 64 * SECOND],
  ])('after %i failures the next attempt waits %i ms', (failures, expected) => {
    expect(backoffMs(failures)).toBe(expected);
  });

  it('never exceeds five minutes, however many failures there are', () => {
    expect(backoffMs(30)).toBe(5 * MINUTE);
    expect(backoffMs(10_000)).toBe(5 * MINUTE);
  });
});

describe('effective end of a lock', () => {
  it('is the recorded lock time when there is one', () => {
    expect(
      effectiveLockEnd({ failedLogins: 10, lastFailedAt: T0, lockedUntil: after(MINUTE) }),
    ).toEqual(after(MINUTE));
  });

  it('is derived from the last failure when the counter reached the limit but no lock was written (a crashed attempt)', () => {
    expect(effectiveLockEnd({ failedLogins: 10, lastFailedAt: T0, lockedUntil: null })).toEqual(
      after(15 * MINUTE),
    );
  });

  it('is none below the limit', () => {
    expect(effectiveLockEnd({ failedLogins: 9, lastFailedAt: T0, lockedUntil: null })).toBeNull();
    expect(effectiveLockEnd({ failedLogins: 0, lastFailedAt: null, lockedUntil: null })).toBeNull();
  });
});

describe('gate decision before credentials are checked', () => {
  const open = { failedLogins: 0, lastFailedAt: null, lockedUntil: null };

  it('lets a clean account through', () => {
    expect(gateDecision(open, T0)).toEqual({ kind: 'open', expiredLock: false });
  });

  it('refuses a locked account until the lock ends, whatever the password will be', () => {
    const locked = { failedLogins: 10, lastFailedAt: T0, lockedUntil: after(15 * MINUTE) };

    expect(gateDecision(locked, after(14 * MINUTE))).toEqual({
      kind: 'locked',
      until: after(15 * MINUTE),
    });
    expect(gateDecision(locked, after(15 * MINUTE - 1))).toMatchObject({ kind: 'locked' });
  });

  it('opens a fresh budget when the lock window has passed, and says the lock expired', () => {
    const locked = { failedLogins: 10, lastFailedAt: T0, lockedUntil: after(15 * MINUTE) };

    expect(gateDecision(locked, after(15 * MINUTE))).toEqual({ kind: 'open', expiredLock: true });
    expect(gateDecision(locked, after(16 * MINUTE))).toEqual({ kind: 'open', expiredLock: true });
  });

  it('delays the next attempt according to the backoff schedule', () => {
    const state = { failedLogins: 4, lastFailedAt: T0, lockedUntil: null };

    expect(gateDecision(state, after(1999))).toEqual({
      kind: 'throttled',
      retryAt: after(2 * SECOND),
    });
    expect(gateDecision(state, after(2 * SECOND))).toEqual({ kind: 'open', expiredLock: false });
  });

  it('does not delay the first two failures', () => {
    expect(
      gateDecision({ failedLogins: 2, lastFailedAt: T0, lockedUntil: null }, after(1)),
    ).toEqual({
      kind: 'open',
      expiredLock: false,
    });
  });

  it('honours a custom policy', () => {
    const policy = { maxFailures: 3, lockMs: MINUTE };
    const state = { failedLogins: 3, lastFailedAt: T0, lockedUntil: null };

    expect(gateDecision(state, after(30 * SECOND), policy)).toMatchObject({ kind: 'locked' });
    expect(gateDecision(state, after(MINUTE), policy)).toEqual({ kind: 'open', expiredLock: true });
  });
});

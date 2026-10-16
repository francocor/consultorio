import { describe, expect, it } from 'vitest';

import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  hashSessionToken,
  newSessionToken,
  sessionVerdict,
} from './sessions.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date('2026-10-16T08:00:00.000Z');
const after = (ms: number) => new Date(T0.getTime() + ms);

const fresh = {
  revokedAt: null,
  lastSeenAt: T0,
  expiresAt: after(SESSION_ABSOLUTE_MS),
};

describe('session lifetime (idle 30 minutes, absolute 7 days)', () => {
  it('uses the staff timeouts of the design (ASVS 3.3.2: 30 minutes of inactivity)', () => {
    expect(SESSION_IDLE_MS).toBe(30 * MINUTE);
    expect(SESSION_ABSOLUTE_MS).toBe(7 * 24 * HOUR);
  });

  it('is active while it is used within the idle window', () => {
    expect(sessionVerdict(fresh, after(10 * MINUTE))).toBe('active');
    expect(sessionVerdict(fresh, after(SESSION_IDLE_MS - 1))).toBe('active');
  });

  it('expires from inactivity exactly at the idle limit', () => {
    expect(sessionVerdict(fresh, after(SESSION_IDLE_MS))).toBe('idle_expired');
    expect(sessionVerdict(fresh, after(SESSION_IDLE_MS + 12 * HOUR))).toBe('idle_expired');
  });

  it('keeps an active session alive by use, up to the absolute limit', () => {
    const lastWeek = { ...fresh, lastSeenAt: after(SESSION_ABSOLUTE_MS - 10 * MINUTE) };

    expect(sessionVerdict(lastWeek, after(SESSION_ABSOLUTE_MS - 1))).toBe('active');
    expect(sessionVerdict(lastWeek, after(SESSION_ABSOLUTE_MS))).toBe('absolute_expired');
  });

  it('reports the absolute limit even when the session was just used', () => {
    const justUsed = { ...fresh, lastSeenAt: after(SESSION_ABSOLUTE_MS + 1) };

    expect(sessionVerdict(justUsed, after(SESSION_ABSOLUTE_MS + 2))).toBe('absolute_expired');
  });

  it('is revoked whatever the clock says', () => {
    expect(sessionVerdict({ ...fresh, revokedAt: after(HOUR) }, after(1))).toBe('revoked');
  });
});

describe('session tokens', () => {
  it('are 256 bits of base64url (43 characters) and never repeat', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newSessionToken()));

    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('are stored as a SHA-256 hex digest that differs from the token', () => {
    const token = newSessionToken();
    const hash = hashSessionToken(token);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashSessionToken(token)).toBe(hash);
    expect(hashSessionToken(newSessionToken())).not.toBe(hash);
  });

  it('hashes to the well-known SHA-256 of a known input', () => {
    expect(hashSessionToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

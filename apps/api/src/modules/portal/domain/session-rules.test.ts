import { describe, expect, it } from 'vitest';

import {
  PORTAL_SESSION_ABSOLUTE_MS,
  PORTAL_SESSION_IDLE_MS,
  portalSessionVerdict,
} from './session-rules.js';

const START = new Date('2031-05-05T12:00:00.000Z');
const at = (ms: number) => new Date(START.getTime() + ms);
const fresh = {
  revokedAt: null,
  lastSeenAt: START,
  expiresAt: at(PORTAL_SESSION_ABSOLUTE_MS),
};

describe('how long a portal session lives', () => {
  it('is 30 minutes of inactivity and 12 hours at most', () => {
    expect(PORTAL_SESSION_IDLE_MS).toBe(30 * 60_000);
    expect(PORTAL_SESSION_ABSOLUTE_MS).toBe(12 * 3_600_000);
  });

  it('is active just before the idle limit and idle expired at it', () => {
    expect(portalSessionVerdict(fresh, at(PORTAL_SESSION_IDLE_MS - 1))).toBe('active');
    expect(portalSessionVerdict(fresh, at(PORTAL_SESSION_IDLE_MS))).toBe('idle_expired');
  });

  it('ends at the absolute limit even when the person never stopped using it', () => {
    const busy = { ...fresh, lastSeenAt: at(PORTAL_SESSION_ABSOLUTE_MS - 1_000) };

    expect(portalSessionVerdict(busy, at(PORTAL_SESSION_ABSOLUTE_MS - 500))).toBe('active');
    expect(portalSessionVerdict(busy, at(PORTAL_SESSION_ABSOLUTE_MS))).toBe('absolute_expired');
  });

  it('is revoked whatever the clock says', () => {
    expect(portalSessionVerdict({ ...fresh, revokedAt: START }, START)).toBe('revoked');
  });
});

import { describe, expect, it } from 'vitest';

import {
  PORTAL_CODE_ATTEMPTS,
  PORTAL_CODE_ATTEMPTS_PER_CHALLENGE,
  PORTAL_CODE_LIFETIME_MS,
  PORTAL_CODE_REQUESTS_PER_CLIENT,
  PORTAL_CODE_SENDS_PER_HOUR,
  addressKey,
  challengeTriesKey,
  codeMatches,
  generateCode,
  hashCode,
  requestsKey,
  triesKey,
} from './code.js';

describe('the code of the portal', () => {
  it('has the limits of the design: ten minutes, five attempts, three sends an hour', () => {
    expect(PORTAL_CODE_LIFETIME_MS).toBe(600_000);
    expect(PORTAL_CODE_ATTEMPTS).toBe(5);
    expect(PORTAL_CODE_SENDS_PER_HOUR).toBe(3);
  });

  it('counts five tries per client, twenty per challenge and six requests an hour per client (R2-4)', () => {
    expect(PORTAL_CODE_ATTEMPTS).toBe(5);
    expect(PORTAL_CODE_ATTEMPTS_PER_CHALLENGE).toBe(20);
    expect(PORTAL_CODE_REQUESTS_PER_CLIENT).toBe(6);
    expect(PORTAL_CODE_ATTEMPTS_PER_CHALLENGE).toBeGreaterThan(PORTAL_CODE_ATTEMPTS);
  });

  it('keys the tries of a client by challenge and by a hash of the client', () => {
    const key = challengeTriesKey('challenge-1', '10.0.0.1');

    expect(key).toBe(challengeTriesKey('challenge-1', '10.0.0.1'));
    expect(key).not.toBe(challengeTriesKey('challenge-1', '10.0.0.2'));
    expect(key).not.toBe(challengeTriesKey('challenge-2', '10.0.0.1'));
    expect(key).not.toContain('10.0.0.1');
  });

  it('keys a client without an address by its user agent too, so one NAT is not one bucket (R3-7)', () => {
    const behindNat = requestsKey('tenant-1', null, 'Mozilla/5.0 (Android)');

    expect(behindNat).toBe(requestsKey('tenant-1', null, 'Mozilla/5.0 (Android)'));
    expect(behindNat).not.toBe(requestsKey('tenant-1', null, 'Mozilla/5.0 (iPhone)'));
    expect(behindNat).not.toBe(requestsKey('tenant-1', null, null));
    expect(behindNat).not.toBe(requestsKey('tenant-2', null, 'Mozilla/5.0 (Android)'));
    expect(triesKey('tenant-1', 'a@b.test', null, 'UA-1')).not.toBe(
      triesKey('tenant-1', 'a@b.test', null, 'UA-2'),
    );
    expect(challengeTriesKey('challenge-1', null, 'UA-1')).not.toBe(
      challengeTriesKey('challenge-1', null, 'UA-2'),
    );
  });

  it('ignores the user agent when the address of the client is known', () => {
    expect(requestsKey('tenant-1', '10.0.0.1', 'UA-1')).toBe(
      requestsKey('tenant-1', '10.0.0.1', 'UA-2'),
    );
    expect(requestsKey('tenant-1', '10.0.0.1', 'UA-1')).not.toContain('UA-1');
  });

  it('is six digits and keeps its leading zeros', () => {
    expect(generateCode(() => 48_213)).toBe('048213');
    expect(generateCode(() => 0)).toBe('000000');
    expect(generateCode(() => 999_999)).toBe('999999');
    expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it('is stored as a hash tied to the challenge: the same digits hash differently for another one', () => {
    expect(hashCode('challenge-1', '123456')).not.toBe(hashCode('challenge-2', '123456'));
    expect(hashCode('challenge-1', '123456')).not.toContain('123456');
  });

  it('matches only the code that was hashed, and nothing when no code was hashed yet', () => {
    const stored = hashCode('challenge-1', '123456');

    expect(codeMatches('challenge-1', '123456', stored)).toBe(true);
    expect(codeMatches('challenge-1', '123457', stored)).toBe(false);
    expect(codeMatches('challenge-2', '123456', stored)).toBe(false);
    expect(codeMatches('challenge-1', '123456', null)).toBe(false);
  });

  it('keys the counters of an address by a hash that ignores the case, per organization', () => {
    const key = addressKey('tenant-1', 'Ana@Example.test');

    expect(key).toBe(addressKey('tenant-1', 'ana@example.test '));
    expect(key).not.toBe(addressKey('tenant-2', 'ana@example.test'));
    expect(key).not.toContain('ana');
  });
});

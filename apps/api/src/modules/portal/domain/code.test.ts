import { describe, expect, it } from 'vitest';

import {
  PORTAL_CODE_ATTEMPTS,
  PORTAL_CODE_LIFETIME_MS,
  PORTAL_CODE_SENDS_PER_HOUR,
  addressKey,
  codeMatches,
  generateCode,
  hashCode,
} from './code.js';

describe('the code of the portal', () => {
  it('has the limits of the design: ten minutes, five attempts, three sends an hour', () => {
    expect(PORTAL_CODE_LIFETIME_MS).toBe(600_000);
    expect(PORTAL_CODE_ATTEMPTS).toBe(5);
    expect(PORTAL_CODE_SENDS_PER_HOUR).toBe(3);
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

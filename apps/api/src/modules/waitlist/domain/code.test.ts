import { describe, expect, it } from 'vitest';

import {
  CODE_ATTEMPTS,
  CODE_LIFETIME_MS,
  CODE_SENDS_PER_HOUR,
  codeMatches,
  generateCode,
  hashCode,
  maskEmail,
} from './code.js';

describe('the one-time code of a join', () => {
  it('has the limits of the public flows: ten minutes, five attempts, three sends an hour', () => {
    expect(CODE_LIFETIME_MS).toBe(10 * 60_000);
    expect(CODE_ATTEMPTS).toBe(5);
    expect(CODE_SENDS_PER_HOUR).toBe(3);
  });

  it('is six digits, zeros included', () => {
    expect(generateCode(() => 0)).toBe('000000');
    expect(generateCode(() => 42)).toBe('000042');
    expect(generateCode(() => 999_999)).toBe('999999');
    expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it('is stored as a hash tied to its challenge, so the same digits differ between challenges', () => {
    expect(hashCode('challenge-a', '123456')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode('challenge-a', '123456')).toBe(hashCode('challenge-a', '123456'));
    expect(hashCode('challenge-a', '123456')).not.toBe(hashCode('challenge-b', '123456'));
    expect(hashCode('challenge-a', '123456')).not.toBe(hashCode('challenge-a', '123457'));
  });

  it('matches only the code that was hashed, and nothing before a hash exists', () => {
    const stored = hashCode('challenge-a', '123456');

    expect(codeMatches('challenge-a', '123456', stored)).toBe(true);
    expect(codeMatches('challenge-a', '654321', stored)).toBe(false);
    expect(codeMatches('challenge-b', '123456', stored)).toBe(false);
    expect(codeMatches('challenge-a', '123456', null)).toBe(false);
    expect(codeMatches('challenge-a', '123456', 'short')).toBe(false);
  });

  it('hides an address down to its first letter and its domain', () => {
    expect(maskEmail('lucia@example.test')).toBe('l***@example.test');
    expect(maskEmail('x')).toBe('***');
    expect(maskEmail('@example.test')).toBe('***');
  });
});

import { describe, expect, it } from 'vitest';

import {
  CODE_ATTEMPTS,
  CODE_LIFETIME_MS,
  CODE_SENDS_PER_HOUR,
  codeMatches,
  generateCode,
  hashCode,
  maskEmail,
} from './otp.js';

describe('the limits of a code', () => {
  it('are the ones of the spec: ten minutes, five attempts, three sends an hour', () => {
    expect(CODE_LIFETIME_MS).toBe(10 * 60_000);
    expect(CODE_ATTEMPTS).toBe(5);
    expect(CODE_SENDS_PER_HOUR).toBe(3);
  });
});

describe('generateCode', () => {
  it('is six digits, zeros included', () => {
    expect(generateCode(() => 7)).toBe('000007');
    expect(generateCode(() => 123_456)).toBe('123456');
    expect(generateCode(() => 999_999)).toBe('999999');
  });

  it('asks the source for a number below a million', () => {
    let asked = 0;
    generateCode((max) => {
      asked = max;
      return 0;
    });

    expect(asked).toBe(1_000_000);
  });

  it('draws different codes from the real source', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));

    expect(codes.size).toBeGreaterThan(40);
    for (const code of codes) expect(code).toMatch(/^\d{6}$/);
  });
});

describe('hashCode and codeMatches', () => {
  it('ties the hash to the challenge: the same code hashes differently for another one', () => {
    expect(hashCode('challenge-1', '123456')).not.toBe(hashCode('challenge-2', '123456'));
    expect(hashCode('challenge-1', '123456')).toBe(hashCode('challenge-1', '123456'));
    expect(hashCode('challenge-1', '123456')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never contains the code', () => {
    expect(hashCode('c', '123456')).not.toContain('123456');
  });

  it('accepts the right code and nothing else', () => {
    const stored = hashCode('challenge-1', '123456');

    expect(codeMatches('challenge-1', '123456', stored)).toBe(true);
    expect(codeMatches('challenge-1', '123457', stored)).toBe(false);
    expect(codeMatches('challenge-2', '123456', stored)).toBe(false);
  });

  it('accepts nothing when no code was ever generated', () => {
    expect(codeMatches('challenge-1', '123456', null)).toBe(false);
  });
});

describe('maskEmail', () => {
  it.each([
    ['lucia@example.test', 'l***@example.test'],
    ['a@example.test', 'a***@example.test'],
    ['maria.gonzalez@clinica.com.ar', 'm***@clinica.com.ar'],
  ])('hides the local part of %s', (address, masked) => {
    expect(maskEmail(address)).toBe(masked);
  });

  it('hides a value that is not an address', () => {
    expect(maskEmail('nonsense')).toBe('***');
  });
});

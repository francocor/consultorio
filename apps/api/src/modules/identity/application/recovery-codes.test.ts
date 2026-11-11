import { describe, expect, it } from 'vitest';

import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './recovery-codes.js';

describe('recovery codes', () => {
  it('come in sets of ten distinct codes of four groups of four characters', () => {
    const codes = generateRecoveryCodes();

    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes)
      expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  });

  it('avoid characters that are easy to confuse when read aloud or copied by hand', () => {
    const text = generateRecoveryCodes(200).join('');

    expect(text).not.toMatch(/[01ilo]/);
  });

  it('never repeat across sets', () => {
    const first = new Set(generateRecoveryCodes(50));
    const second = generateRecoveryCodes(50);

    expect(second.some((code) => first.has(code))).toBe(false);
  });

  it('are accepted however the user types them: spaces, hyphens and capitals do not matter', () => {
    expect(normalizeRecoveryCode('ABCD-efgh-jkmn-pqrs')).toBe('abcdefghjkmnpqrs');
    expect(normalizeRecoveryCode('  abcd efgh jkmn pqrs ')).toBe('abcdefghjkmnpqrs');
    expect(normalizeRecoveryCode('abcdefghjkmnpqrs')).toBe('abcdefghjkmnpqrs');
  });

  it.each([
    '',
    'short',
    'abcd-efgh-jkmn-pqr',
    'abcd-efgh-jkmn-pqrst',
    'abcd-efgh-jkmn-pqr!',
    '0000-0000-0000-0000',
  ])('rejects %j as malformed', (input) => {
    expect(normalizeRecoveryCode(input)).toBeNull();
  });

  it('are stored as a SHA-256 digest that does not contain the code', () => {
    const hash = hashRecoveryCode('abcdefghjkmnpqrs');

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('abcdefgh');
    expect(hashRecoveryCode('abcdefghjkmnpqrs')).toBe(hash);
    expect(hashRecoveryCode('abcdefghjkmnpqrt')).not.toBe(hash);
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  formatCuit,
  normalizeDigits,
  validateCuit,
  validateNationalId,
  validatePassport,
} from './identifiers.js';

describe('DNI validation and normalization', () => {
  it.each([
    ['30.123.456', '30123456'],
    ['30 123 456', '30123456'],
    ['30-123-456', '30123456'],
    ['12345678', '12345678'],
    ['1.234.567', '1234567'],
  ])('accepts %j and stores %j', (input, expected) => {
    expect(validateNationalId(input)).toEqual({ ok: true, value: expected });
  });

  it.each(['12AB', '', '   ', '12', '123456789', '30.123.45a', '0', '00000000'])(
    'rejects %j with an es-AR message key',
    (input) => {
      expect(validateNationalId(input)).toEqual({
        ok: false,
        error: { i18nKey: 'country.ar.national_id.invalid' },
      });
    },
  );

  it('normalizeDigits keeps only digits', () => {
    expect(normalizeDigits(' 30.123-456 ')).toBe('30123456');
  });

  it('normalization is idempotent (property)', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const once = normalizeDigits(input);
        expect(normalizeDigits(once)).toBe(once);
      }),
    );
  });

  it('a valid DNI always normalizes to the same value it was validated as (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1_000_000, max: 99_999_999 }), (number) => {
        const plain = String(number);
        const dotted = plain.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        expect(validateNationalId(dotted)).toEqual({ ok: true, value: plain });
      }),
    );
  });
});

describe('passport', () => {
  it('normalizes to uppercase alphanumerics', () => {
    expect(validatePassport(' ab-123456 ')).toEqual({ ok: true, value: 'AB123456' });
  });

  it.each(['', 'AB', 'A'.repeat(21), 'AB 12$456'])('rejects %j', (input) => {
    expect(validatePassport(input).ok).toBe(false);
  });
});

describe('CUIT/CUIL', () => {
  it.each([
    ['20-12345678-6', '20123456786'],
    ['20123456786', '20123456786'],
    ['30-71234567-1', '30712345671'],
    ['27-12345678-0', '27123456780'],
  ])('accepts %j and normalizes it to %j', (input, expected) => {
    expect(validateCuit(input)).toEqual({ ok: true, value: expected });
  });

  it('rejects a wrong check digit', () => {
    expect(validateCuit('20-12345678-5')).toEqual({
      ok: false,
      error: { i18nKey: 'country.ar.tax_id.invalid' },
    });
  });

  it.each([
    ['a prefix that is not assigned', '10-12345678-9'],
    ['too few digits', '20-1234567-6'],
    ['too many digits', '20-123456789-6'],
    ['letters', '20-1234567A-6'],
    ['an empty value', ''],
  ])('rejects %s', (_label, input) => {
    expect(validateCuit(input).ok).toBe(false);
  });

  it('computes the check digit with the 5-4-3-2-7-6-5-4-3-2 weights (property)', () => {
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    fc.assert(
      fc.property(
        fc.constantFrom('20', '23', '24', '27', '30', '33', '34'),
        fc.integer({ min: 0, max: 99_999_999 }),
        (prefix, body) => {
          const base = `${prefix}${String(body).padStart(8, '0')}`;
          const sum = weights.reduce(
            (total, weight, index) => total + Number(base.charAt(index)) * weight,
            0,
          );
          const raw = 11 - (sum % 11);
          // A raw check digit of 10 has no valid CUIT with this prefix: skip those.
          fc.pre(raw !== 10);
          const check = raw === 11 ? 0 : raw;

          expect(validateCuit(`${base}${String(check)}`)).toEqual({
            ok: true,
            value: `${base}${String(check)}`,
          });
          expect(validateCuit(`${base}${String((check + 1) % 10)}`).ok).toBe(false);
        },
      ),
    );
  });

  it('formats a normalized CUIT with hyphens', () => {
    expect(formatCuit('20123456786')).toBe('20-12345678-6');
  });
});

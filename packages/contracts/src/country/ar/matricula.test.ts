import { describe, expect, it } from 'vitest';

import { AR_JURISDICTIONS, validateMatricula } from './matricula.js';

describe('matricula jurisdictions', () => {
  it('lists the 24 provincial jurisdictions plus the national registry', () => {
    expect(AR_JURISDICTIONS.provincial).toHaveLength(24);
    expect(new Set(AR_JURISDICTIONS.provincial.map((jurisdiction) => jurisdiction.code)).size).toBe(
      24,
    );
    expect(AR_JURISDICTIONS.national).toBe('NATIONAL');
  });

  it('includes the city of Buenos Aires and the province of Buenos Aires separately', () => {
    const codes = AR_JURISDICTIONS.provincial.map((jurisdiction) => jurisdiction.code);

    expect(codes).toEqual(expect.arrayContaining(['AR-C', 'AR-B']));
  });
});

describe('matricula format (format only, not verification)', () => {
  it.each([
    ['NATIONAL', 'MN 12345', '12345'],
    ['NATIONAL', 'M.N. 98.765', '98765'],
    ['AR-B', 'MP 123456', '123456'],
    ['AR-C', 'm.p. 7', '7'],
    ['AR-X', '1234567', '1234567'],
    ['AR-T', ' 45 678 ', '45678'],
  ])('accepts %s %j and normalizes the number to %j', (jurisdiction, input, number) => {
    expect(validateMatricula(jurisdiction, input)).toEqual({
      ok: true,
      value: { jurisdiction, number },
    });
  });

  it.each([
    ['letters instead of a number', 'AR-B', 'ABC'],
    ['an empty number', 'AR-B', ''],
    ['a prefix without a number', 'AR-B', 'MP'],
    ['too many digits', 'AR-B', '12345678'],
    ['a zero number', 'AR-B', '0'],
    ['a national number with a provincial prefix', 'NATIONAL', 'MP 12345'],
  ])('rejects %s', (_label, jurisdiction, input) => {
    expect(validateMatricula(jurisdiction, input)).toEqual({
      ok: false,
      error: { i18nKey: 'country.ar.matricula.invalid' },
    });
  });

  it('rejects an unknown jurisdiction with its own message key', () => {
    expect(validateMatricula('AR-ZZ', '12345')).toEqual({
      ok: false,
      error: { i18nKey: 'country.ar.matricula.unknown_jurisdiction' },
    });
  });
});

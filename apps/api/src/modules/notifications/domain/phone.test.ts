import { describe, expect, it } from 'vitest';

import { normalizeWhatsAppNumber } from './phone.js';

describe('normalizeWhatsAppNumber', () => {
  it.each([
    ['+54 9 11 4444-5555', '+5491144445555'],
    ['+5491144445555', '+5491144445555'],
    ['0054 9 11 4444 5555', '+5491144445555'],
    ['+1 (415) 555-0100', '+14155550100'],
  ])('keeps an international number written with a country code: %s', (raw, expected) => {
    expect(normalizeWhatsAppNumber(raw)).toBe(expected);
  });

  it.each([
    ['1144445555', '+5491144445555'],
    ['011 4444-5555', '+5491144445555'],
    ['011 15 4444-5555', '+5491144445555'],
    ['0351 15 512-3456', '+5493515123456'],
    ['0221 15 456 7890', '+5492214567890'],
    ['(0341) 155-123456', '+5493415123456'],
  ])('reads a national Argentine number as a mobile: %s', (raw, expected) => {
    expect(normalizeWhatsAppNumber(raw)).toBe(expected);
  });

  it('adds the mobile 9 to a number written with 54 but without it', () => {
    expect(normalizeWhatsAppNumber('54 11 4444 5555')).toBe('+5491144445555');
  });

  it.each(['', 'abc', '4444-5555', '15 4444 5555', '12345', '+1234567890123456'])(
    'gives up on something that cannot be a number: %j',
    (raw) => {
      expect(normalizeWhatsAppNumber(raw)).toBeNull();
    },
  );

  it('keeps the reserved test prefix, which the local simulator treats as not on WhatsApp', () => {
    expect(normalizeWhatsAppNumber('+999 100 2000')).toBe('+9991002000');
  });
});

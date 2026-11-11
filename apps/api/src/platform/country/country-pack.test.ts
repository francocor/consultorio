import { describe, expect, it } from 'vitest';

import { getCountryPack, type CatalogReader } from './country-pack.js';

const catalogs: CatalogReader = {
  holidays: () => Promise.resolve([]),
  payers: () => Promise.resolve([]),
};

describe('country pack registry', () => {
  it('returns the Argentina pack for AR', () => {
    const result = getCountryPack('AR', catalogs);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.code).toBe('AR');
      expect(result.value.validateNationalId('30.123.456')).toEqual({
        ok: true,
        value: '30123456',
      });
    }
  });

  it.each(['XX', 'ar', '', 'BR'])('refuses the unsupported country %j with a clear key', (code) => {
    expect(getCountryPack(code, catalogs)).toEqual({
      ok: false,
      error: { i18nKey: 'errors.unsupported_country' },
    });
  });
});

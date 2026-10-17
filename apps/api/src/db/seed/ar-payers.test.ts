import { PAYER_KINDS } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { arPayers } from './ar-payers.js';

describe('Argentine payer seed', () => {
  it('offers the self-pay option "Particular" next to the catalog payers', () => {
    const particular = arPayers.find((payer) => payer.code === 'particular');

    expect(particular).toEqual({
      country: 'AR',
      code: 'particular',
      name: 'Particular',
      kind: 'private',
    });
    expect(arPayers.filter((payer) => payer.kind !== 'private').length).toBeGreaterThan(8);
  });

  it('has unique codes, known kinds and the AR country on every entry', () => {
    const codes = arPayers.map((payer) => payer.code);

    expect(new Set(codes).size).toBe(codes.length);
    for (const payer of arPayers) {
      expect(PAYER_KINDS).toContain(payer.kind);
      expect(payer.country).toBe('AR');
      expect(payer.code).toMatch(/^[a-z0-9_]+$/);
      expect(payer.name.length).toBeGreaterThan(1);
    }
  });
});

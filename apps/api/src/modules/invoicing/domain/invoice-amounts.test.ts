import { describe, expect, it } from 'vitest';

import { allocateCredit, breakdownFor, lineWording, planParts } from './invoice-amounts.js';

describe('the breakdown of an invoice total (e-invoicing-afip, "Issuing an invoice with CAE")', () => {
  it('is all net for a Factura C, which does not itemize VAT', () => {
    expect(breakdownFor('FC', 2_000_000)).toEqual({
      netCents: 2_000_000,
      vatCents: 0,
      exemptCents: 0,
    });
    expect(breakdownFor('NCC', 1_500)).toEqual({ netCents: 1_500, vatCents: 0, exemptCents: 0 });
  });

  it('is all exempt for a Factura A or B: assistance services of health are exempt from VAT', () => {
    expect(breakdownFor('FA', 2_000_000)).toEqual({
      netCents: 0,
      vatCents: 0,
      exemptCents: 2_000_000,
    });
    expect(breakdownFor('FB', 1)).toEqual({ netCents: 0, vatCents: 0, exemptCents: 1 });
    expect(breakdownFor('NCB', 700)).toEqual({ netCents: 0, vatCents: 0, exemptCents: 700 });
  });

  it('always adds up to the total', () => {
    for (const type of ['FA', 'FB', 'FC', 'NCA', 'NCB', 'NCC'] as const) {
      const { netCents, vatCents, exemptCents } = breakdownFor(type, 123_457);
      expect(netCents + vatCents + exemptCents).toBe(123_457);
    }
  });
});

describe('the parts of an invoice over charge lines', () => {
  const lines = [
    { id: 'a', uninvoicedCents: 10_000 },
    { id: 'b', uninvoicedCents: 4_000 },
  ];

  it('covers what is left of every line when no amount is given', () => {
    expect(planParts(lines, [{ chargeLineId: 'a' }, { chargeLineId: 'b' }])).toEqual({
      ok: true,
      parts: [
        { chargeLineId: 'a', amountCents: 10_000 },
        { chargeLineId: 'b', amountCents: 4_000 },
      ],
      totalCents: 14_000,
    });
  });

  it('covers a line in a part when an amount is given', () => {
    expect(planParts(lines, [{ chargeLineId: 'a', amountCents: 6_000 }])).toEqual({
      ok: true,
      parts: [{ chargeLineId: 'a', amountCents: 6_000 }],
      totalCents: 6_000,
    });
  });

  it('refuses an amount above what is left, and a line with nothing left', () => {
    expect(planParts(lines, [{ chargeLineId: 'b', amountCents: 4_001 }])).toEqual({
      ok: false,
      reason: 'over_invoiced',
      chargeLineId: 'b',
    });
    expect(planParts([{ id: 'c', uninvoicedCents: 0 }], [{ chargeLineId: 'c' }])).toEqual({
      ok: false,
      reason: 'over_invoiced',
      chargeLineId: 'c',
    });
  });

  it('refuses the same line twice in one invoice, and a line that was not read', () => {
    expect(
      planParts(lines, [
        { chargeLineId: 'a', amountCents: 1 },
        { chargeLineId: 'a', amountCents: 2 },
      ]),
    ).toEqual({ ok: false, reason: 'duplicate', chargeLineId: 'a' });
    expect(planParts(lines, [{ chargeLineId: 'zzz' }])).toEqual({
      ok: false,
      reason: 'unknown',
      chargeLineId: 'zzz',
    });
  });
});

describe('how a credit note takes back the lines of an invoice', () => {
  it('splits a partial note over the lines in proportion to what each can still take back', () => {
    // The lines can still take back 12.000 and 8.000: a note of 10.000 takes 6.000 and 4.000.
    expect(allocateCredit([12_000, 8_000], 10_000)).toEqual([6_000, 4_000]);
  });

  it('gives a total note exactly what is left of every line', () => {
    expect(allocateCredit([12_000, 8_000], 20_000)).toEqual([12_000, 8_000]);
    expect(allocateCredit([5_000, 0, 3_000], 8_000)).toEqual([5_000, 0, 3_000]);
  });

  it('adds up to the note and never gives a line more than it can take back, cent by cent', () => {
    const left = [3_333, 3_333, 3_334];
    for (const amount of [1, 2, 3, 100, 5_000, 9_999, 10_000]) {
      const parts = allocateCredit(left, amount);
      expect(parts.reduce((sum, part) => sum + part, 0)).toBe(amount);
      parts.forEach((part, index) => {
        expect(part).toBeGreaterThanOrEqual(0);
        expect(part).toBeLessThanOrEqual(left[index] ?? 0);
      });
    }
  });

  it('refuses a note beyond what is left, and a note when nothing is left', () => {
    expect(() => allocateCredit([100, 50], 151)).toThrow(RangeError);
    expect(() => allocateCredit([0, 0], 1)).toThrow(RangeError);
  });
});

describe('the wording of an invoice line (e-invoicing-afip, "Invoice document and delivery")', () => {
  it('names the service by the generic wording of the appointment type', () => {
    expect(lineWording({ kind: 'service', serviceName: 'Consulta profesional' })).toBe(
      'Consulta profesional',
    );
    expect(lineWording({ kind: 'service', serviceName: '  ' })).toBe('Servicios de salud');
  });

  it('never prints what a person typed on a charge line', () => {
    expect(lineWording({ kind: 'copago', serviceName: 'Consulta' })).toBe('Copago');
    expect(lineWording({ kind: 'plus', serviceName: 'Consulta' })).toBe('Plus');
    expect(lineWording({ kind: 'late_fee', serviceName: 'Consulta' })).toBe(
      'Cargo por turno no cancelado',
    );
    expect(lineWording({ kind: 'manual', serviceName: 'Estudio de HIV' })).toBe('Otros conceptos');
    expect(lineWording({ kind: 'payer_coverage', serviceName: 'Consulta profesional' })).toBe(
      'Consulta profesional',
    );
  });
});

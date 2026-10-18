import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  resolvePrice,
  type PayerChoice,
  type PayerPriceRule,
  type PriceContext,
  type PriceRule,
} from './price-resolution.js';

const TYPE = 'type-consulta';
const OTHER_TYPE = 'type-control';
const DR_A = 'prof-a';
const DR_B = 'prof-b';
const CENTRO = 'loc-centro';
const NORTE = 'loc-norte';

const context = (overrides: Partial<PriceContext> = {}): PriceContext => ({
  appointmentTypeId: TYPE,
  professionalId: DR_A,
  professionalSpecialties: ['clínica médica'],
  locationId: CENTRO,
  onDate: '2031-05-12',
  ...overrides,
});

let n = 0;
const rule = (overrides: Partial<PriceRule> = {}): PriceRule => {
  n += 1;
  return {
    id: `price-${String(n)}`,
    appointmentTypeId: TYPE,
    professionalId: null,
    specialty: null,
    locationId: null,
    amountCents: 2_000_000,
    effectiveFrom: '2031-01-01',
    active: true,
    ...overrides,
  };
};

const payerRule = (overrides: Partial<PayerPriceRule> = {}): PayerPriceRule => {
  n += 1;
  return {
    id: `payer-price-${String(n)}`,
    tenantPayerId: 'osde',
    planName: null,
    appointmentTypeId: TYPE,
    payerAmountCents: 1_500_000,
    copagoCents: 300_000,
    plusCents: 0,
    effectiveFrom: '2031-01-01',
    active: true,
    ...overrides,
  };
};

const osde = (overrides: Partial<PayerChoice> = {}): PayerChoice => ({
  tenantPayerId: 'osde',
  planName: '210',
  active: true,
  ...overrides,
});

const quote = (input: {
  prices?: PriceRule[];
  payerPrices?: PayerPriceRule[];
  payer?: PayerChoice | null;
  context?: PriceContext;
}) =>
  resolvePrice({
    context: input.context ?? context(),
    payer: input.payer ?? null,
    prices: input.prices ?? [],
    payerPrices: input.payerPrices ?? [],
  });

describe('the private price', () => {
  it('is the whole amount owed by the patient, in one line', () => {
    const result = quote({ prices: [rule({ amountCents: 2_000_000 })] });

    expect(result).toMatchObject({
      ok: true,
      quote: {
        source: 'private',
        totalCents: 2_000_000,
        patientCents: 2_000_000,
        payerCents: 0,
        lines: [{ kind: 'service', portion: 'patient', amountCents: 2_000_000 }],
      },
    });
  });

  it('answers NoPrice, never an implied zero, when nothing matches', () => {
    expect(quote({ prices: [] })).toEqual({ ok: false, reason: 'no_price' });
    expect(quote({ prices: [rule({ appointmentTypeId: OTHER_TYPE })] })).toEqual({
      ok: false,
      reason: 'no_price',
    });
  });

  it('ignores a deactivated price and one that starts in the future', () => {
    const prices = [
      rule({ active: false, amountCents: 9_000_000 }),
      rule({ effectiveFrom: '2031-05-13', amountCents: 8_000_000 }),
    ];

    expect(quote({ prices })).toEqual({ ok: false, reason: 'no_price' });
  });

  it('uses the price that starts on the very day of the appointment', () => {
    const result = quote({
      prices: [rule({ effectiveFrom: '2031-05-12', amountCents: 2_200_000 })],
    });

    expect(result).toMatchObject({ ok: true, quote: { totalCents: 2_200_000 } });
  });

  it('takes the latest price that is not in the future, and keeps the old one for earlier dates', () => {
    const prices = [
      rule({ effectiveFrom: '2031-01-01', amountCents: 2_000_000 }),
      rule({ effectiveFrom: '2031-05-01', amountCents: 2_200_000 }),
      rule({ effectiveFrom: '2031-09-01', amountCents: 2_600_000 }),
    ];

    expect(quote({ prices })).toMatchObject({ quote: { totalCents: 2_200_000 } });
    expect(quote({ prices, context: context({ onDate: '2031-04-30' }) })).toMatchObject({
      quote: { totalCents: 2_000_000 },
    });
    expect(quote({ prices, context: context({ onDate: '2032-01-01' }) })).toMatchObject({
      quote: { totalCents: 2_600_000 },
    });
  });
});

describe('specificity', () => {
  it('prefers the price of the professional over the general one, only for that professional', () => {
    const prices = [
      rule({ amountCents: 2_000_000 }),
      rule({ professionalId: DR_A, amountCents: 2_500_000 }),
    ];

    expect(quote({ prices })).toMatchObject({ quote: { totalCents: 2_500_000 } });
    expect(quote({ prices, context: context({ professionalId: DR_B }) })).toMatchObject({
      quote: { totalCents: 2_000_000 },
    });
  });

  it('orders professional, then specialty, then location, then general', () => {
    const general = rule({ amountCents: 1_000_000 });
    const location = rule({ locationId: CENTRO, amountCents: 2_000_000 });
    const specialty = rule({ specialty: 'Clínica Médica', amountCents: 3_000_000 });
    const professional = rule({ professionalId: DR_A, amountCents: 4_000_000 });
    const total = (prices: PriceRule[]) => {
      const result = quote({ prices });
      return result.ok ? result.quote.totalCents : null;
    };

    expect(total([general, location, specialty, professional])).toBe(4_000_000);
    expect(total([general, location, specialty])).toBe(3_000_000);
    expect(total([general, location])).toBe(2_000_000);
    expect(total([general])).toBe(1_000_000);
  });

  it('applies a location price only at that location', () => {
    const prices = [
      rule({ amountCents: 2_000_000 }),
      rule({ locationId: NORTE, amountCents: 2_400_000 }),
    ];

    expect(quote({ prices })).toMatchObject({ quote: { totalCents: 2_000_000 } });
    expect(quote({ prices, context: context({ locationId: NORTE }) })).toMatchObject({
      quote: { totalCents: 2_400_000 },
    });
  });

  it('applies a specialty price only to a professional with that specialty, whatever its case', () => {
    const prices = [
      rule({ amountCents: 2_000_000 }),
      rule({ specialty: 'PEDIATRÍA', amountCents: 2_300_000 }),
    ];

    expect(quote({ prices })).toMatchObject({ quote: { totalCents: 2_000_000 } });
    expect(
      quote({
        prices,
        context: context({ professionalSpecialties: ['pediatría', 'neonatología'] }),
      }),
    ).toMatchObject({ quote: { totalCents: 2_300_000 } });
  });

  it('lets a more specific price win even when a less specific one is newer', () => {
    const prices = [
      rule({ professionalId: DR_A, effectiveFrom: '2031-01-01', amountCents: 2_500_000 }),
      rule({ effectiveFrom: '2031-05-01', amountCents: 9_900_000 }),
    ];

    expect(quote({ prices })).toMatchObject({ quote: { totalCents: 2_500_000 } });
  });

  it('answers the same for any order of the list', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          [
            rule({ amountCents: 1_000_000 }),
            rule({ locationId: CENTRO, amountCents: 2_000_000 }),
            rule({ professionalId: DR_A, amountCents: 4_000_000 }),
            rule({ professionalId: DR_A, locationId: CENTRO, amountCents: 5_000_000 }),
            rule({ specialty: 'clínica médica', amountCents: 3_000_000 }),
          ],
          { minLength: 5 },
        ),
        (shuffled) => {
          const result = quote({ prices: shuffled });
          expect(result).toMatchObject({ ok: true, quote: { totalCents: 5_000_000 } });
        },
      ),
    );
  });
});

describe('the payer plan price', () => {
  it('splits the copago from what the payer covers, and tracks the payer portion apart', () => {
    const result = quote({
      prices: [rule()],
      payerPrices: [payerRule({ payerAmountCents: 1_500_000, copagoCents: 300_000 })],
      payer: osde(),
    });

    expect(result).toMatchObject({
      ok: true,
      quote: {
        source: 'payer',
        tenantPayerId: 'osde',
        planName: '210',
        totalCents: 1_800_000,
        patientCents: 300_000,
        payerCents: 1_500_000,
        lines: [
          { kind: 'payer_coverage', portion: 'payer', amountCents: 1_500_000 },
          { kind: 'copago', portion: 'patient', amountCents: 300_000 },
        ],
      },
    });
  });

  it('shows the plus as its own line, apart from the copago', () => {
    const result = quote({
      payerPrices: [payerRule({ copagoCents: 300_000, plusCents: 500_000 })],
      payer: osde(),
    });

    expect(result).toMatchObject({
      quote: {
        patientCents: 800_000,
        payerCents: 1_500_000,
        lines: [
          { kind: 'payer_coverage', amountCents: 1_500_000 },
          { kind: 'copago', portion: 'patient', amountCents: 300_000 },
          { kind: 'plus', portion: 'patient', amountCents: 500_000 },
        ],
      },
    });
  });

  it('leaves out the lines that are zero', () => {
    const covered = quote({
      payerPrices: [payerRule({ copagoCents: 0, plusCents: 0 })],
      payer: osde(),
    });
    const onlyPlus = quote({
      payerPrices: [payerRule({ payerAmountCents: 0, copagoCents: 0, plusCents: 400_000 })],
      payer: osde(),
    });

    expect(covered).toMatchObject({
      quote: { patientCents: 0, lines: [{ kind: 'payer_coverage' }] },
    });
    expect(onlyPlus).toMatchObject({
      quote: { payerCents: 0, patientCents: 400_000, lines: [{ kind: 'plus' }] },
    });
  });

  it('prefers the price of the exact plan over the one for every plan of the payer', () => {
    const payerPrices = [
      payerRule({ planName: null, copagoCents: 400_000 }),
      payerRule({ planName: '210', copagoCents: 250_000 }),
    ];

    expect(quote({ payerPrices, payer: osde({ planName: '210' }) })).toMatchObject({
      quote: { patientCents: 250_000 },
    });
    expect(quote({ payerPrices, payer: osde({ planName: '310' }) })).toMatchObject({
      quote: { patientCents: 400_000 },
    });
    expect(quote({ payerPrices, payer: osde({ planName: null }) })).toMatchObject({
      quote: { patientCents: 400_000 },
    });
  });

  it('takes the latest payer price that is not in the future', () => {
    const payerPrices = [
      payerRule({ effectiveFrom: '2031-01-01', copagoCents: 300_000 }),
      payerRule({ effectiveFrom: '2031-05-01', copagoCents: 350_000 }),
      payerRule({ effectiveFrom: '2031-09-01', copagoCents: 450_000 }),
    ];

    expect(quote({ payerPrices, payer: osde() })).toMatchObject({
      quote: { patientCents: 350_000 },
    });
  });

  it('only counts the prices of that payer, for that appointment type', () => {
    const payerPrices = [
      payerRule({ tenantPayerId: 'swiss', copagoCents: 111_000 }),
      payerRule({ appointmentTypeId: OTHER_TYPE, copagoCents: 222_000 }),
      payerRule({ active: false, copagoCents: 333_000 }),
    ];

    const result = quote({ prices: [rule()], payerPrices, payer: osde() });

    expect(result).toMatchObject({
      quote: { source: 'private', notes: ['payer_without_price'] },
    });
  });

  it('falls back to the private price, and says why, when the payer has no price for the type', () => {
    const result = quote({ prices: [rule({ amountCents: 2_000_000 })], payer: osde() });

    expect(result).toMatchObject({
      ok: true,
      quote: { source: 'private', totalCents: 2_000_000, notes: ['payer_without_price'] },
    });
  });

  it('is NoPrice when the payer has no price and there is no private price either', () => {
    expect(quote({ payer: osde() })).toEqual({ ok: false, reason: 'no_price' });
  });

  it('does not offer a deactivated payer: the private price applies, with the reason', () => {
    const result = quote({
      prices: [rule()],
      payerPrices: [payerRule()],
      payer: osde({ active: false }),
    });

    expect(result).toMatchObject({
      quote: { source: 'private', patientCents: 2_000_000, notes: ['payer_inactive'] },
    });
  });
});

describe('the quote always adds up', () => {
  it('has patient plus payer equal to the total, and the lines equal to the total', () => {
    const amount = fc.integer({ min: 0, max: 50_000_000 });
    fc.assert(
      fc.property(amount, amount, amount, (payerAmount, copago, plus) => {
        fc.pre(payerAmount + copago + plus > 0);
        const result = quote({
          payerPrices: [
            payerRule({ payerAmountCents: payerAmount, copagoCents: copago, plusCents: plus }),
          ],
          payer: osde(),
        });
        if (!result.ok) throw new Error('expected a quote');
        const { quote: q } = result;

        expect(q.patientCents + q.payerCents).toBe(q.totalCents);
        expect(q.totalCents).toBe(payerAmount + copago + plus);
        expect(q.lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(q.totalCents);
        expect(q.lines.every((line) => line.amountCents > 0)).toBe(true);
        expect(
          q.lines
            .filter((line) => line.portion === 'patient')
            .reduce((s, l) => s + l.amountCents, 0),
        ).toBe(q.patientCents);
      }),
    );
  });
});

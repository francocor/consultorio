import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MONEY_ZERO,
  Money as MoneySchema,
  NonNegativeMoney,
  addMoney,
  allocateProportional,
  applyBasisPoints,
  formatArs,
  isMoney,
  money,
  negateMoney,
  parseArs,
  subtractMoney,
  sumMoney,
} from './money.js';

describe('money (integer ARS cents)', () => {
  it('builds an amount only from a safe integer, so a float can never become money', () => {
    expect(money(123_450)).toBe(123_450);
    expect(() => money(12.5)).toThrow(RangeError);
    expect(() => money(Number.NaN)).toThrow(RangeError);
    expect(() => money(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });

  it('knows what is money at runtime', () => {
    expect(isMoney(0)).toBe(true);
    expect(isMoney(-5)).toBe(true);
    expect(isMoney(1.5)).toBe(false);
    expect(isMoney('100')).toBe(false);
    expect(isMoney(null)).toBe(false);
  });

  it('has a schema for the wire: an integer, with a non negative variant for prices and payments', () => {
    expect(MoneySchema.parse(-300)).toBe(-300);
    expect(MoneySchema.safeParse(12.5).success).toBe(false);
    expect(MoneySchema.safeParse('100').success).toBe(false);
    expect(NonNegativeMoney.parse(0)).toBe(0);
    expect(NonNegativeMoney.safeParse(-1).success).toBe(false);
  });

  it('adds, subtracts and negates exactly', () => {
    expect(addMoney(money(10_000), money(2_550))).toBe(12_550);
    expect(subtractMoney(money(10_000), money(12_550))).toBe(-2_550);
    expect(negateMoney(money(500))).toBe(-500);
    expect(Object.is(negateMoney(MONEY_ZERO), 0)).toBe(true);
    expect(sumMoney([money(1), money(2), money(3)])).toBe(6);
    expect(sumMoney([])).toBe(0);
  });

  it('refuses a result outside the safe integers instead of losing cents', () => {
    expect(() => addMoney(money(Number.MAX_SAFE_INTEGER), money(1))).toThrow(RangeError);
  });
});

describe('applyBasisPoints (a percentage, rounded half away from zero)', () => {
  it('computes 21% of an amount in whole cents', () => {
    expect(applyBasisPoints(money(10_000), 2_100)).toBe(2_100);
    // 21% of 333 cents = 69.93 cents -> 70
    expect(applyBasisPoints(money(333), 2_100)).toBe(70);
  });

  it('rounds exactly half away from zero, for credits as for debits', () => {
    // 50% of 5 cents = 2.5 -> 3 ; of -5 cents = -2.5 -> -3
    expect(applyBasisPoints(money(5), 5_000)).toBe(3);
    expect(applyBasisPoints(money(-5), 5_000)).toBe(-3);
    // 50% of 3 cents = 1.5 -> 2
    expect(applyBasisPoints(money(3), 5_000)).toBe(2);
    // 10% of 4 cents = 0.4 -> 0
    expect(applyBasisPoints(money(4), 1_000)).toBe(0);
  });

  it('does not lose precision on large amounts', () => {
    expect(applyBasisPoints(money(9_007_199_254_740), 10_000)).toBe(9_007_199_254_740);
  });

  it('rejects a rate that is not an integer number of basis points', () => {
    expect(() => applyBasisPoints(money(100), 12.5)).toThrow(RangeError);
  });
});

describe('allocateProportional (largest remainder, ties to the earliest line)', () => {
  it('splits a total by weights so the parts always add up to it', () => {
    expect(allocateProportional(money(10_000), [1, 1, 1])).toEqual([3_334, 3_333, 3_333]);
    expect(allocateProportional(money(100), [1, 2])).toEqual([33, 67]);
  });

  it('gives the leftover cents to the largest remainders, and a tie to the earliest line', () => {
    // 10 cents over three equal lines: remainders tie, the earliest line takes the extra cent.
    expect(allocateProportional(money(10), [1, 1, 1])).toEqual([4, 3, 3]);
    // 5 cents over [1,1,3]: quotas 1, 1, 3 exactly, nothing left.
    expect(allocateProportional(money(5), [1, 1, 3])).toEqual([1, 1, 3]);
    // 2 cents over [3,3,3]: quotas 0.666 each, two extra cents go to the first two lines.
    expect(allocateProportional(money(2), [3, 3, 3])).toEqual([1, 1, 0]);
    // The larger remainder wins over position: quotas 1.4, 0.6 -> extra cent to the second line.
    expect(allocateProportional(money(2), [7, 3])).toEqual([1, 1]);
  });

  it('gives a zero weight nothing, and allocates zero to every line when the total is zero', () => {
    expect(allocateProportional(money(100), [0, 1, 0])).toEqual([0, 100, 0]);
    expect(allocateProportional(money(0), [3, 4])).toEqual([0, 0]);
    expect(allocateProportional(money(100), [])).toEqual([]);
  });

  it('refuses what has no answer: weights that sum to zero with money to give, negative weights', () => {
    expect(() => allocateProportional(money(100), [0, 0])).toThrow(RangeError);
    expect(() => allocateProportional(money(100), [1, -1])).toThrow(RangeError);
    expect(() => allocateProportional(money(100), [1.5, 1])).toThrow(RangeError);
    expect(() => allocateProportional(money(-100), [1, 1])).toThrow(RangeError);
  });

  it('property: the parts always sum to the total and are never negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(weights.some((weight) => weight > 0));
          const parts = allocateProportional(money(total), weights);

          expect(parts).toHaveLength(weights.length);
          expect(sumMoney(parts)).toBe(total);
          for (const part of parts) expect(part).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('property: each part is its quota rounded down or up, never further away', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 1_000 }), { minLength: 1, maxLength: 8 }),
        (total, weights) => {
          const sum = weights.reduce((a, b) => a + b, 0);
          const parts = allocateProportional(money(total), weights);
          parts.forEach((part, index) => {
            const quota = (total * (weights[index] ?? 0)) / sum;
            expect(part).toBeGreaterThanOrEqual(Math.floor(quota));
            expect(part).toBeLessThanOrEqual(Math.ceil(quota));
          });
        },
      ),
    );
  });

  it('property: the same input always gives the same answer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 6 }),
        (total, weights) => {
          expect(allocateProportional(money(total), weights)).toEqual(
            allocateProportional(money(total), weights),
          );
        },
      ),
    );
  });
});

describe('formatArs and parseArs ("$ 1.234,50")', () => {
  it('writes an amount the Argentine way', () => {
    expect(formatArs(money(123_450))).toBe('$ 1.234,50');
    expect(formatArs(money(0))).toBe('$ 0,00');
    expect(formatArs(money(5))).toBe('$ 0,05');
    expect(formatArs(money(100))).toBe('$ 1,00');
    expect(formatArs(money(100_000_000))).toBe('$ 1.000.000,00');
  });

  it('puts the sign before the peso sign', () => {
    expect(formatArs(money(-9_000))).toBe('-$ 90,00');
    expect(formatArs(money(-5))).toBe('-$ 0,05');
  });

  it('reads what a person types', () => {
    expect(parseArs('1.234,50')).toBe(123_450);
    expect(parseArs('$ 1.234,50')).toBe(123_450);
    expect(parseArs('1234,5')).toBe(123_450);
    expect(parseArs('1234')).toBe(123_400);
    expect(parseArs('  35.000  ')).toBe(3_500_000);
    expect(parseArs('0,05')).toBe(5);
    expect(parseArs('-90,00')).toBe(-9_000);
    expect(parseArs('$-90')).toBe(-9_000);
  });

  it.each([
    '',
    '   ',
    '$',
    'abc',
    '12,345',
    '1,2,3',
    '1.23',
    '1234.5',
    '1.2345,00',
    '12..345',
    ',50',
    '1e3',
    '1 000',
    '--5',
    '99999999999999999999',
  ])('refuses "%s" instead of guessing', (text) => {
    expect(parseArs(text)).toBeNull();
  });

  it('property: parsing what was formatted gives the same amount back', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }), (cents) => {
        expect(parseArs(formatArs(money(cents)))).toBe(cents);
      }),
    );
  });
});

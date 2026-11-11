import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { differenceOf, summarizeSession, type CashMovement } from './cash-summary.js';

const taken = (method: CashMovement['method'], amountCents: number): CashMovement => ({
  direction: 'in',
  method,
  amountCents,
});
const back = (method: CashMovement['method'], amountCents: number): CashMovement => ({
  direction: 'out',
  method,
  amountCents,
});

describe('the cash a register should hold', () => {
  it('is the opening cash plus the cash taken (the day of the spec: 5.000 + 30.000)', () => {
    const summary = summarizeSession(500_000, [taken('cash', 1_800_000), taken('cash', 1_200_000)]);

    expect(summary.expectedCents).toBe(3_500_000);
    expect(summary.cashInCents).toBe(3_000_000);
    expect(summary.cashOutCents).toBe(0);
  });

  it('subtracts the cash given back and ignores what is not cash', () => {
    const summary = summarizeSession(500_000, [
      taken('cash', 3_000_000),
      taken('debit', 9_000_000),
      taken('transfer', 1_000_000),
      back('cash', 400_000),
      back('credit', 700_000),
    ]);

    expect(summary.expectedCents).toBe(3_100_000);
    expect(summary.cashInCents).toBe(3_000_000);
    expect(summary.cashOutCents).toBe(400_000);
  });

  it('is the opening cash alone for a day without movements', () => {
    expect(summarizeSession(250_000, []).expectedCents).toBe(250_000);
    expect(summarizeSession(0, []).expectedCents).toBe(0);
  });

  it('may go below zero when a correction gives back more cash than the day took', () => {
    expect(summarizeSession(0, [back('cash', 100_000)]).expectedCents).toBe(-100_000);
  });
});

describe('the summary by method', () => {
  it('lists every method that moved, with what came in, what went back and the net', () => {
    const summary = summarizeSession(0, [
      taken('cash', 1_000_000),
      taken('cash', 500_000),
      back('cash', 200_000),
      taken('debit', 800_000),
      back('debit', 800_000),
      taken('transfer', 300_000),
    ]);

    expect(summary.byMethod).toEqual([
      {
        method: 'cash',
        count: 3,
        paymentsCents: 1_500_000,
        refundsCents: 200_000,
        netCents: 1_300_000,
      },
      { method: 'debit', count: 2, paymentsCents: 800_000, refundsCents: 800_000, netCents: 0 },
      { method: 'transfer', count: 1, paymentsCents: 300_000, refundsCents: 0, netCents: 300_000 },
    ]);
  });

  it('keeps the order of the methods of the catalog and omits the ones that did not move', () => {
    const summary = summarizeSession(0, [taken('wallet', 100), taken('cash', 100)]);

    expect(summary.byMethod.map((row) => row.method)).toEqual(['cash', 'wallet']);
  });

  it('adds up, for any movements, to what the methods say', () => {
    const movement = fc.record({
      direction: fc.constantFrom('in', 'out'),
      method: fc.constantFrom('cash', 'debit', 'credit', 'transfer', 'wallet', 'payment_link'),
      amountCents: fc.integer({ min: 1, max: 5_000_000 }),
    });
    fc.assert(
      fc.property(
        fc.array(movement, { maxLength: 30 }),
        fc.integer({ min: 0, max: 2_000_000 }),
        (movements, opening) => {
          const summary = summarizeSession(opening, movements);
          const cashNet = summary.byMethod.find((row) => row.method === 'cash')?.netCents ?? 0;

          expect(summary.expectedCents).toBe(opening + cashNet);
          for (const row of summary.byMethod) {
            expect(row.netCents).toBe(row.paymentsCents - row.refundsCents);
          }
        },
      ),
    );
  });
});

describe('the difference at closing', () => {
  it('is counted minus expected: negative when cash is missing', () => {
    expect(differenceOf(3_500_000, 3_500_000)).toBe(0);
    expect(differenceOf(3_500_000, 3_400_000)).toBe(-100_000);
    expect(differenceOf(3_500_000, 3_650_000)).toBe(150_000);
  });
});

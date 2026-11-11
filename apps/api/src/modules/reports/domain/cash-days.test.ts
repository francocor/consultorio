import { describe, expect, it } from 'vitest';

import { buildCashDays, type CashRegisterFact } from './cash-days.js';

const CENTRO = '0190a000-0000-7000-8000-00000000000a';
const NORTE = '0190a000-0000-7000-8000-00000000000b';

let sequence = 0;

function register(overrides: Partial<CashRegisterFact> = {}): CashRegisterFact {
  sequence += 1;
  return {
    id: `0190a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    locationId: CENTRO,
    locationName: 'Centro',
    date: '2031-05-12',
    status: 'closed',
    openedAt: new Date('2031-05-12T11:00:00Z'),
    closedAt: new Date('2031-05-12T20:00:00Z'),
    openingCents: 1_000_000,
    expectedCents: 3_000_000,
    countedCents: 3_000_000,
    differenceCents: 0,
    differenceReason: null,
    byMethod: [
      {
        method: 'cash',
        paymentCount: 3,
        paymentsCents: 2_500_000,
        refundCount: 1,
        refundsCents: 500_000,
      },
    ],
    ...overrides,
  };
}

describe('buildCashDays', () => {
  it('shows the difference of a closed register together with the reason that was given', () => {
    const { days, totals } = buildCashDays([
      register({
        countedCents: 2_900_000,
        differenceCents: -100_000,
        differenceReason: 'Vuelto mal dado',
      }),
    ]);

    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      date: '2031-05-12',
      locationName: 'Centro',
      openingCents: 1_000_000,
      expectedCents: 3_000_000,
      countedCents: 2_900_000,
      differenceCents: -100_000,
      closedSessions: 1,
      openSessions: 0,
    });
    expect(days[0]?.sessions[0]).toMatchObject({
      differenceCents: -100_000,
      differenceReason: 'Vuelto mal dado',
    });
    expect(totals).toMatchObject({ differenceCents: -100_000, daysWithDifference: 1 });
  });

  it('reports a day without a difference as exact, and counts no day with a difference', () => {
    const { days, totals } = buildCashDays([register()]);

    expect(days[0]?.differenceCents).toBe(0);
    expect(totals.daysWithDifference).toBe(0);
  });

  it('adds the registers of one location and day, and keeps the reason of each one', () => {
    const { days } = buildCashDays([
      register({
        differenceCents: -50_000,
        countedCents: 2_950_000,
        differenceReason: 'Falta un billete',
      }),
      register({
        openedAt: new Date('2031-05-12T21:00:00Z'),
        openingCents: 500_000,
        expectedCents: 700_000,
        countedCents: 800_000,
        differenceCents: 100_000,
        differenceReason: 'Sobrante',
        byMethod: [
          {
            method: 'cash',
            paymentCount: 1,
            paymentsCents: 200_000,
            refundCount: 0,
            refundsCents: 0,
          },
          {
            method: 'debit',
            paymentCount: 2,
            paymentsCents: 900_000,
            refundCount: 0,
            refundsCents: 0,
          },
        ],
      }),
    ]);

    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({
      openingCents: 1_500_000,
      expectedCents: 3_700_000,
      countedCents: 3_750_000,
      differenceCents: 50_000,
      paymentsCents: 3_600_000,
      refundsCents: 500_000,
      closedSessions: 2,
    });
    expect(days[0]?.sessions.map((session) => session.differenceReason)).toEqual([
      'Falta un billete',
      'Sobrante',
    ]);
    expect(days[0]?.byMethod).toEqual([
      {
        method: 'cash',
        count: 5,
        paymentsCents: 2_700_000,
        refundsCents: 500_000,
        netCents: 2_200_000,
      },
      { method: 'debit', count: 2, paymentsCents: 900_000, refundsCents: 0, netCents: 900_000 },
    ]);
  });

  it('counts an open register for the expected cash but leaves out its counted cash and difference', () => {
    const { days, totals } = buildCashDays([
      register({
        status: 'open',
        closedAt: null,
        countedCents: null,
        differenceCents: null,
        expectedCents: 1_800_000,
      }),
    ]);

    expect(days[0]).toMatchObject({
      expectedCents: 1_800_000,
      countedCents: null,
      differenceCents: null,
      openSessions: 1,
      closedSessions: 0,
    });
    expect(totals).toMatchObject({ countedCents: null, differenceCents: null });
  });

  it('keeps a location apart from another on the same day, and orders days and places', () => {
    const { days } = buildCashDays([
      register({ locationId: NORTE, locationName: 'Norte' }),
      register({ date: '2031-05-11' }),
      register(),
    ]);

    expect(days.map((day) => [day.date, day.locationName])).toEqual([
      ['2031-05-11', 'Centro'],
      ['2031-05-12', 'Centro'],
      ['2031-05-12', 'Norte'],
    ]);
  });

  it('adds up the totals of the period by method in the order of the catalog', () => {
    const { totals } = buildCashDays([
      register(),
      register({
        date: '2031-05-13',
        byMethod: [
          {
            method: 'transfer',
            paymentCount: 1,
            paymentsCents: 700_000,
            refundCount: 0,
            refundsCents: 0,
          },
        ],
      }),
    ]);

    expect(totals.byMethod.map((row) => row.method)).toEqual(['cash', 'transfer']);
    expect(totals).toMatchObject({
      openingCents: 2_000_000,
      paymentsCents: 3_200_000,
      refundsCents: 500_000,
    });
  });

  it('has nothing to add up for a period without registers', () => {
    const { days, totals } = buildCashDays([]);

    expect(days).toEqual([]);
    expect(totals).toMatchObject({
      openingCents: 0,
      paymentsCents: 0,
      expectedCents: 0,
      countedCents: null,
      differenceCents: null,
      daysWithDifference: 0,
      byMethod: [],
    });
  });
});

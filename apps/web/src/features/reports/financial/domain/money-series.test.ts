import { money, type FinancialRow } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { groupPeriods, sumRows } from './money-series.js';

function row(key: string, extra: Partial<FinancialRow> = {}): FinancialRow {
  return {
    key,
    label: null,
    chargedCents: money(1_000_000),
    voidedCents: money(0),
    paymentsCents: money(600_000),
    refundsCents: money(100_000),
    collectedCents: money(500_000),
    outstandingCents: money(400_000),
    receivableCents: money(0),
    invoicedNetCents: money(300_000),
    ...extra,
  };
}

describe('groupPeriods', () => {
  it('keeps one row per day when the days reach over no more than two months', () => {
    const { unit, rows } = groupPeriods([row('2031-05-12'), row('2031-06-03')]);

    expect(unit).toBe('day');
    expect(rows.map((entry) => entry.key)).toEqual(['2031-05-12', '2031-06-03']);
  });

  it('adds the days up by month when they reach over more than two', () => {
    const { unit, rows } = groupPeriods([
      row('2031-05-12'),
      row('2031-05-20', {
        chargedCents: money(2_000_000),
        refundsCents: money(0),
        collectedCents: money(600_000),
      }),
      row('2031-06-03'),
      row('2031-07-01'),
    ]);

    expect(unit).toBe('month');
    expect(rows.map((entry) => entry.key)).toEqual(['2031-05', '2031-06', '2031-07']);
    expect(rows[0]).toMatchObject({
      chargedCents: 3_000_000,
      paymentsCents: 1_200_000,
      refundsCents: 100_000,
      collectedCents: 1_100_000,
      outstandingCents: 800_000,
      invoicedNetCents: 600_000,
    });
  });

  it('has nothing to group for a period without rows', () => {
    expect(groupPeriods([])).toEqual({ unit: 'day', rows: [] });
  });
});

describe('sumRows', () => {
  it('adds every figure of the rows of a breakdown, and leaves the net invoiced empty when no row has it', () => {
    const total = sumRows([row('a'), row('b', { chargedCents: money(500_000) })]);
    const byType = sumRows([row('a', { invoicedNetCents: null })]);

    expect(total).toMatchObject({ chargedCents: 1_500_000, collectedCents: 1_000_000 });
    expect(total.invoicedNetCents).toBe(600_000);
    expect(byType.invoicedNetCents).toBeNull();
  });
});

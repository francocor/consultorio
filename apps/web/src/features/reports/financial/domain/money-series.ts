import { money, type FinancialRow } from '@consultorio/contracts';

type Figures = Omit<FinancialRow, 'key' | 'label'>;

const ZERO: Figures = {
  chargedCents: money(0),
  voidedCents: money(0),
  paymentsCents: money(0),
  refundsCents: money(0),
  collectedCents: money(0),
  outstandingCents: money(0),
  receivableCents: money(0),
  invoicedNetCents: null,
};

/** Adds the figures of some rows. The net invoiced stays empty when no row says it. */
export function sumRows(rows: readonly FinancialRow[]): Figures {
  return rows.reduce<Figures>(
    (total, row) => ({
      chargedCents: money(total.chargedCents + row.chargedCents),
      voidedCents: money(total.voidedCents + row.voidedCents),
      paymentsCents: money(total.paymentsCents + row.paymentsCents),
      refundsCents: money(total.refundsCents + row.refundsCents),
      collectedCents: money(total.collectedCents + row.collectedCents),
      outstandingCents: money(total.outstandingCents + row.outstandingCents),
      receivableCents: money(total.receivableCents + row.receivableCents),
      invoicedNetCents:
        row.invoicedNetCents === null
          ? total.invoicedNetCents
          : money((total.invoicedNetCents ?? 0) + row.invoicedNetCents),
    }),
    ZERO,
  );
}

export interface PeriodRow extends Figures {
  /** `YYYY-MM-DD` for a day, `YYYY-MM` for a month. */
  key: string;
}

/**
 * The days of a report as a series for a chart and its table: one row per day, or one per month
 * when the days reach over more than two months (a bar per day of a year cannot be read on a phone).
 */
export function groupPeriods(days: readonly FinancialRow[]): {
  unit: 'day' | 'month';
  rows: PeriodRow[];
} {
  const first = days[0]?.key;
  const last = days.at(-1)?.key;
  const months =
    first && last
      ? (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
        Number(last.slice(5, 7)) -
        Number(first.slice(5, 7)) +
        1
      : 0;
  if (months <= 2) {
    return {
      unit: 'day',
      rows: days.map((day) => ({ key: day.key, ...sumRows([day]) })),
    };
  }
  const byMonth = new Map<string, FinancialRow[]>();
  for (const day of days) {
    const key = day.key.slice(0, 7);
    byMonth.set(key, [...(byMonth.get(key) ?? []), day]);
  }
  return {
    unit: 'month',
    rows: [...byMonth.entries()].map(([key, rows]) => ({ key, ...sumRows(rows) })),
  };
}

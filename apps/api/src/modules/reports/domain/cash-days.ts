import {
  PAYMENT_METHODS,
  money,
  type CashDayRow,
  type CashReportResponse,
  type MethodRow,
} from '@consultorio/contracts';

import type { CashRegisterFact } from '../../billing/index.js';

export type { CashRegisterFact };

/**
 * The cash register report (reports, "Cash register report"): the registers of a period added up per
 * location and day. Pure.
 *
 * - A register belongs to the day it was opened, however late it was closed.
 * - Expected cash counts every register, open or closed (a closed one writes it when it closes).
 *   Counted cash and the difference come only from closed registers: an open one has none.
 * - The difference of a day is the sum of the differences of its closed registers, and each register
 *   keeps its own difference and reason, so a day that nets to zero still shows what happened.
 * - Every method appears by method, but only cash is in the drawer.
 */
export function buildCashDays(registers: readonly CashRegisterFact[]): {
  days: CashDayRow[];
  totals: CashReportResponse['totals'];
} {
  const byDay = new Map<string, CashRegisterFact[]>();
  for (const register of registers) {
    const key = `${register.date}|${register.locationId}`;
    byDay.set(key, [...(byDay.get(key) ?? []), register]);
  }

  const days = [...byDay.values()]
    .map(dayOf)
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.locationName.localeCompare(b.locationName, 'es'),
    );

  const closed = days.filter((day) => day.countedCents !== null);
  return {
    days,
    totals: {
      openingCents: money(sum(days, (day) => day.openingCents)),
      paymentsCents: money(sum(days, (day) => day.paymentsCents)),
      refundsCents: money(sum(days, (day) => day.refundsCents)),
      expectedCents: money(sum(days, (day) => day.expectedCents)),
      countedCents: closed.length === 0 ? null : money(sum(closed, (day) => day.countedCents ?? 0)),
      differenceCents:
        closed.length === 0 ? null : money(sum(closed, (day) => day.differenceCents ?? 0)),
      daysWithDifference: days.filter((day) =>
        day.sessions.some(
          (session) => session.differenceCents !== null && session.differenceCents !== 0,
        ),
      ).length,
      byMethod: methodTotals(days.flatMap((day) => day.byMethod)),
    },
  };
}

function sum<T>(items: readonly T[], amount: (item: T) => number): number {
  return items.reduce((total, item) => total + amount(item), 0);
}

function dayOf(registers: readonly CashRegisterFact[]): CashDayRow {
  const [first] = registers;
  if (!first) throw new Error('a day of the cash report has at least one register');
  const ordered = [...registers].sort(
    (a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.id.localeCompare(b.id),
  );
  const closed = ordered.filter((register) => register.status === 'closed');
  const byMethod = methodTotals(
    ordered.flatMap((register) =>
      register.byMethod.map((entry): MethodRow => ({
        method: entry.method,
        count: entry.paymentCount + entry.refundCount,
        paymentsCents: money(entry.paymentsCents),
        refundsCents: money(entry.refundsCents),
        netCents: money(entry.paymentsCents - entry.refundsCents),
      })),
    ),
  );
  return {
    date: first.date,
    locationId: first.locationId,
    locationName: first.locationName,
    openingCents: money(sum(ordered, (register) => register.openingCents)),
    paymentsCents: money(sum(byMethod, (row) => row.paymentsCents)),
    refundsCents: money(sum(byMethod, (row) => row.refundsCents)),
    expectedCents: money(sum(ordered, (register) => register.expectedCents)),
    countedCents:
      closed.length === 0 ? null : money(sum(closed, (register) => register.countedCents ?? 0)),
    differenceCents:
      closed.length === 0 ? null : money(sum(closed, (register) => register.differenceCents ?? 0)),
    openSessions: ordered.length - closed.length,
    closedSessions: closed.length,
    byMethod,
    sessions: ordered.map((register) => ({
      id: register.id,
      status: register.status,
      openedAt: register.openedAt.toISOString(),
      closedAt: register.closedAt?.toISOString() ?? null,
      openingCents: money(register.openingCents),
      expectedCents: money(register.expectedCents),
      countedCents: register.countedCents === null ? null : money(register.countedCents),
      differenceCents: register.differenceCents === null ? null : money(register.differenceCents),
      differenceReason: register.differenceReason,
    })),
  };
}

/** Adds the rows of the same method, in the order of the catalog of methods. */
function methodTotals(rows: readonly MethodRow[]): MethodRow[] {
  return PAYMENT_METHODS.flatMap((method) => {
    const own = rows.filter((row) => row.method === method);
    if (own.length === 0) return [];
    const payments = sum(own, (row) => row.paymentsCents);
    const refunds = sum(own, (row) => row.refundsCents);
    return [
      {
        method,
        count: sum(own, (row) => row.count),
        paymentsCents: money(payments),
        refundsCents: money(refunds),
        netCents: money(payments - refunds),
      },
    ];
  });
}

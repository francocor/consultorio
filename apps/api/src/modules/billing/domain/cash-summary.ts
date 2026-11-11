import { PAYMENT_METHODS, money, type PaymentMethod } from '@consultorio/contracts';

/**
 * The arithmetic of a cash register (billing-payments, "Daily cash register per location"). Pure,
 * in whole cents. Only CASH is in the drawer: cards, transfers and wallets appear in the daily
 * summary by method but never in the cash that should be counted.
 */

/** One entry of the register: money that came in (a payment) or went back (a refund). */
export interface CashMovement {
  direction: 'in' | 'out';
  method: PaymentMethod;
  amountCents: number;
}

export interface MethodTotal {
  method: PaymentMethod;
  count: number;
  paymentsCents: number;
  refundsCents: number;
  netCents: number;
}

export interface SessionSummary {
  /** The cash that should be in the drawer: opening cash plus cash taken minus cash given back. */
  expectedCents: number;
  cashInCents: number;
  cashOutCents: number;
  byMethod: MethodTotal[];
}

export function summarizeSession(
  openingCents: number,
  movements: readonly CashMovement[],
): SessionSummary {
  const totals = new Map<PaymentMethod, MethodTotal>();
  for (const movement of movements) {
    const total = totals.get(movement.method) ?? {
      method: movement.method,
      count: 0,
      paymentsCents: 0,
      refundsCents: 0,
      netCents: 0,
    };
    total.count += 1;
    if (movement.direction === 'in') total.paymentsCents += money(movement.amountCents);
    else total.refundsCents += money(movement.amountCents);
    total.netCents = total.paymentsCents - total.refundsCents;
    totals.set(movement.method, total);
  }

  const cash = totals.get('cash');
  const cashInCents = cash?.paymentsCents ?? 0;
  const cashOutCents = cash?.refundsCents ?? 0;
  return {
    expectedCents: money(openingCents + cashInCents - cashOutCents),
    cashInCents,
    cashOutCents,
    // In the order of the catalog, so the screen and the exports always read the same.
    byMethod: PAYMENT_METHODS.flatMap((method) => {
      const total = totals.get(method);
      return total ? [total] : [];
    }),
  };
}

/** Counted minus expected: negative when cash is missing. */
export function differenceOf(expectedCents: number, countedCents: number): number {
  return money(countedCents - expectedCents);
}

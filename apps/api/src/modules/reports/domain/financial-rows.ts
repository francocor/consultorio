import { money, type FinancialRow } from '@consultorio/contracts';

import type { ChargeFact, PaymentFact } from '../../billing/index.js';
import type { InvoicedGroup } from '../../invoicing/index.js';

export type { ChargeFact, PaymentFact, InvoicedGroup };

/** The key of the private patients in a breakdown by payer (the one invoicing also uses). */
export const PRIVATE_KEY = 'private';

interface Parts {
  label: string | null;
  charge: ChargeFact | undefined;
  payment: PaymentFact | undefined;
  invoiced: InvoicedGroup | undefined;
}

/**
 * Puts the three sources of a dimension side by side: what was charged (by the day of the service),
 * what was collected (by the day the money moved) and what was invoiced (by the date of the
 * voucher). A group that only one source knows still gets its row, with zero for the others: money
 * collected today for a service of last month belongs to today's row of collected and to last
 * month's row of charged. `invoiced` is null for a dimension the voucher cannot say (the type of
 * appointment); then the net invoiced is null, not zero.
 */
export function mergeRows(
  charges: readonly ChargeFact[],
  payments: readonly PaymentFact[],
  invoiced: readonly InvoicedGroup[] | null,
): FinancialRow[] {
  const parts = new Map<string, Parts>();
  const entry = (key: string): Parts => {
    let found = parts.get(key);
    if (!found) {
      found = { label: null, charge: undefined, payment: undefined, invoiced: undefined };
      parts.set(key, found);
    }
    return found;
  };
  for (const fact of charges) {
    const found = entry(fact.key);
    found.charge = fact;
    found.label = found.label ?? fact.label;
  }
  for (const fact of payments) {
    const found = entry(fact.key);
    found.payment = fact;
    found.label = found.label ?? fact.label;
  }
  for (const group of invoiced ?? []) {
    const found = entry(group.key);
    found.invoiced = group;
    found.label = found.label ?? group.label ?? null;
  }

  const rows = [...parts.entries()].map(([key, part]): FinancialRow => {
    const paid = part.payment?.paymentsCents ?? 0;
    const refunded = part.payment?.refundsCents ?? 0;
    return {
      key,
      label: part.label,
      chargedCents: money(part.charge?.chargedCents ?? 0),
      voidedCents: money(part.charge?.voidedCents ?? 0),
      paymentsCents: money(paid),
      refundsCents: money(refunded),
      collectedCents: money(paid - refunded),
      outstandingCents: money(part.charge?.outstandingCents ?? 0),
      receivableCents: money(part.charge?.payerCents ?? 0),
      invoicedNetCents: invoiced === null ? null : money(part.invoiced?.netCents ?? 0),
    };
  });

  return rows.sort((a, b) => {
    if (a.key === PRIVATE_KEY || b.key === PRIVATE_KEY) {
      return a.key === b.key ? 0 : a.key === PRIVATE_KEY ? -1 : 1;
    }
    return (a.label ?? a.key).localeCompare(b.label ?? b.key, 'es');
  });
}

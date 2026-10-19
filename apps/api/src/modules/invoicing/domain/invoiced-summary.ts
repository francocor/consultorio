import type { InvoiceKind, InvoiceType } from '@consultorio/contracts';

/**
 * What the reports read of the invoices (reports-dashboard, S4.14; spec "e-invoicing-afip": a
 * rejected attempt MUST NOT count in reports or fiscal totals, a credit note is a reduction). The
 * reports module reads invoices only through the index of invoicing: `readInvoicedLines` gives the
 * flat rows, this file adds them up. Pure.
 */

/** One line of an issued or registered voucher, with the facts of the charge it covers. */
export interface InvoicedLine {
  invoiceId: string;
  kind: InvoiceKind;
  type: InvoiceType;
  /** Only vouchers that exist count: `issued` and `manual`. */
  status: 'issued' | 'manual';
  /** The date printed on the voucher (`YYYY-MM-DD`). */
  issueDate: string;
  chargeId: string;
  chargeLineId: string;
  locationId: string;
  professionalId: string;
  patientId: string | null;
  /** The payer the charge was made for; null for a private patient. */
  payerId: string | null;
  payerName: string | null;
  /** What the line adds to the total: positive for an invoice, negative for a credit note. */
  netCents: number;
}

export type InvoicedGroupBy =
  'total' | 'day' | 'month' | 'location' | 'professional' | 'payer' | 'type';

export interface InvoicedGroup {
  /** The day, the month, the id of the location, professional or payer, the voucher type, or `all`. */
  key: string;
  /** The name of the payer, when grouped by payer. */
  label?: string;
  invoicedCents: number;
  creditedCents: number;
  /** Invoiced minus credited. */
  netCents: number;
  /** How many vouchers (invoices and credit notes) the group holds. */
  documents: number;
}

/** The label of the private patients in a grouping by payer. */
export const PRIVATE_PAYER_KEY = 'private';

function keyOf(row: InvoicedLine, groupBy: InvoicedGroupBy): string {
  switch (groupBy) {
    case 'total':
      return 'all';
    case 'day':
      return row.issueDate;
    case 'month':
      return row.issueDate.slice(0, 7);
    case 'location':
      return row.locationId;
    case 'professional':
      return row.professionalId;
    case 'payer':
      return row.payerId ?? PRIVATE_PAYER_KEY;
    case 'type':
      return row.type;
  }
}

/**
 * Adds the lines up by one dimension. A line goes to the group of the charge it covers, so a payer
 * invoice is revenue of the payer's group and the location and professional of the charge. The
 * groups come back ordered by key; a total always has a row, even for nothing.
 */
export function summarizeInvoiced(
  rows: readonly InvoicedLine[],
  groupBy: InvoicedGroupBy,
): InvoicedGroup[] {
  const groups = new Map<string, { group: InvoicedGroup; documents: Set<string> }>();
  const ensure = (key: string) => {
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        group: { key, invoicedCents: 0, creditedCents: 0, netCents: 0, documents: 0 },
        documents: new Set(),
      };
      groups.set(key, entry);
    }
    return entry;
  };
  if (groupBy === 'total') ensure('all');

  for (const row of rows) {
    const entry = ensure(keyOf(row, groupBy));
    if (row.netCents >= 0) entry.group.invoicedCents += row.netCents;
    else entry.group.creditedCents += -row.netCents;
    entry.group.netCents += row.netCents;
    entry.documents.add(row.invoiceId);
    if (groupBy === 'payer' && row.payerName !== null) entry.group.label = row.payerName;
  }

  return [...groups.values()]
    .map(({ group, documents }) => ({ ...group, documents: documents.size }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

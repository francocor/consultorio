import { invoiceKindOf, type InvoiceType } from '@consultorio/contracts';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';

import { invoice, invoiceLine } from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readChargeLines } from '../../billing/index.js';
import type { InvoicedLine } from '../domain/invoiced-summary.js';

/** Lines asked of billing at a time: an id list is a query parameter list, not a document. */
const CHUNK = 500;

export interface InvoicedLinesFilter {
  /** First day of the period, inclusive (`YYYY-MM-DD`), by the date printed on the voucher. */
  from: string;
  /** Last day of the period, inclusive. */
  to: string;
}

/**
 * Every line of an issued or registered voucher of a period, with the facts of the charge it covers
 * (location, professional, payer): what the financial reports add up (reports-dashboard, S4.14).
 * Credit notes come with a negative amount. A pending invoice is not a voucher yet and a rejected
 * attempt never was one, so neither appears; the reports never see a retry state.
 *
 * Reports read invoices only through this function (the index of invoicing), and the charge facts
 * come from billing's own exports. The scope of the viewer (a professional sees their own revenue,
 * reception its locations) is the reports module's to apply to these rows.
 */
export async function readInvoicedLines(
  tx: Tx,
  filter: InvoicedLinesFilter,
): Promise<InvoicedLine[]> {
  const rows = await tx
    .select({
      invoiceId: invoice.id,
      type: invoice.type,
      status: invoice.status,
      issueDate: invoice.issueDate,
      chargeId: invoiceLine.chargeId,
      chargeLineId: invoiceLine.chargeLineId,
      amountCents: invoiceLine.amountCents,
    })
    .from(invoiceLine)
    .innerJoin(
      invoice,
      and(eq(invoice.tenantId, invoiceLine.tenantId), eq(invoice.id, invoiceLine.invoiceId)),
    )
    .where(
      and(
        inArray(invoice.status, ['issued', 'manual']),
        gte(invoice.issueDate, filter.from),
        lte(invoice.issueDate, filter.to),
      ),
    )
    .orderBy(asc(invoice.issueDate), asc(invoice.id), asc(invoiceLine.position));

  const facts = new Map<string, Awaited<ReturnType<typeof readChargeLines>>[number]>();
  const ids = [...new Set(rows.map((row) => row.chargeLineId))];
  for (let start = 0; start < ids.length; start += CHUNK) {
    for (const line of await readChargeLines(tx, ids.slice(start, start + CHUNK))) {
      facts.set(line.id, line);
    }
  }

  return rows.flatMap((row) => {
    const charge = facts.get(row.chargeLineId);
    // A line billing cannot show (it cannot happen: the foreign key keeps them together).
    if (!charge) return [];
    const type = row.type as InvoiceType;
    const kind = invoiceKindOf(type);
    return [
      {
        invoiceId: row.invoiceId,
        kind,
        type,
        status: row.status === 'manual' ? ('manual' as const) : ('issued' as const),
        issueDate: row.issueDate,
        chargeId: row.chargeId,
        chargeLineId: row.chargeLineId,
        locationId: charge.locationId,
        professionalId: charge.professionalId,
        patientId: charge.patientId,
        payerId: charge.payer?.id ?? null,
        payerName: charge.payer?.name ?? null,
        netCents: kind === 'credit_note' ? -row.amountCents : row.amountCents,
      },
    ];
  });
}

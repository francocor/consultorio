import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';

import { invoice, invoiceStrayVoucher } from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { CURRENT_TENANT } from './common.js';
import { inSeries, type SeriesKey } from './series-scope.js';

/** The series a number belongs to: point of sale and voucher type (the organization is the context). */
export interface SeriesRef {
  pointOfSale: number;
  type: string;
}

/**
 * Why a number is remembered. A voucher certainly exists under `orphaned` (it arrived for an invoice
 * somebody had closed) and `unmatched` (a voucher that no invoice can record: the foreign one a lookup
 * found, or the one that collided with a number or a CAE we hold). Under `replaced_unresolved` and
 * `parked_unknown` (the number an invoice expected when it was replaced or parked without knowing
 * whether it had been issued) a voucher MAY exist.
 */
export type StrayReason = 'replaced_unresolved' | 'orphaned' | 'unmatched' | 'parked_unknown';

/** Numbers where a voucher may or may not exist: the invoice it was remembered for may never have been issued. */
export const UNCERTAIN_REASONS: readonly StrayReason[] = ['replaced_unresolved', 'parked_unknown'];

/**
 * Remembers a number of the series that the authority may hold a voucher under and that no invoice
 * records (JD-S4 R3-3, R4-3). Idempotent: a number is remembered once, with the reason of the first
 * time. The record is for people and for the screens; it never decides whether a request is sent
 * (the authority's own count does: JD-S4 R5-1).
 */
export async function recordStrayVoucher(
  tx: Tx,
  invoiceId: string,
  series: SeriesRef,
  number: number,
  reason: StrayReason,
): Promise<void> {
  await tx
    .insert(invoiceStrayVoucher)
    .values({
      tenantId: CURRENT_TENANT,
      invoiceId,
      pointOfSale: series.pointOfSale,
      type: series.type,
      number,
      reason,
    })
    .onConflictDoNothing();
}

/** A remembered number, and the invoice it was remembered for. */
export interface StrayInWindow {
  number: number;
  invoiceId: string;
  reason: string;
}

/** The remembered numbers of a series after `from` and up to `to`, lowest first. */
export async function straysBetween(
  tx: Tx,
  series: SeriesKey,
  issuerCuit: string,
  window: { from: number; to: number },
): Promise<StrayInWindow[]> {
  return tx
    .select({
      number: invoiceStrayVoucher.number,
      invoiceId: invoiceStrayVoucher.invoiceId,
      reason: invoiceStrayVoucher.reason,
    })
    .from(invoiceStrayVoucher)
    .innerJoin(invoice, eq(invoice.id, invoiceStrayVoucher.invoiceId))
    .where(
      and(
        inSeries(series, issuerCuit),
        gt(invoiceStrayVoucher.number, window.from),
        lte(invoiceStrayVoucher.number, window.to),
      ),
    )
    .orderBy(asc(invoiceStrayVoucher.number));
}

/** A voucher some invoice of the series records, in the numbers of a window. */
export interface RecordedInWindow {
  number: number;
  invoiceId: string;
  status: string;
  cae: string | null;
}

/** The invoices of a series that record a number after `from` and up to `to`, lowest first. */
export async function recordedBetween(
  tx: Tx,
  series: SeriesKey,
  issuerCuit: string,
  window: { from: number; to: number },
): Promise<RecordedInWindow[]> {
  const rows = await tx
    .select({
      number: invoice.number,
      invoiceId: invoice.id,
      status: invoice.status,
      cae: invoice.cae,
    })
    .from(invoice)
    .where(
      and(
        inSeries(series, issuerCuit),
        sql`${invoice.number} is not null`,
        gt(invoice.number, window.from),
        lte(invoice.number, window.to),
      ),
    )
    .orderBy(asc(invoice.number));
  return rows.flatMap((row) => (row.number === null ? [] : [{ ...row, number: row.number }]));
}

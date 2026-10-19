import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';

import { invoice, invoiceStrayVoucher } from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { CURRENT_TENANT } from './common.js';

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

const UNCERTAIN_REASONS: readonly StrayReason[] = ['replaced_unresolved', 'parked_unknown'];

/**
 * Remembers a number of the series that the authority may hold a voucher under and that no invoice
 * records (JD-S4 R3-3, R4-3). Idempotent: a number is remembered once, with the reason of the first
 * time.
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

/** The highest remembered stray number of the series, or 0 when there is none. */
export async function highestStrayNumber(tx: Tx, series: SeriesRef): Promise<number> {
  const [found] = await tx
    .select({ highest: sql<number>`coalesce(max(${invoiceStrayVoucher.number}), 0)::int` })
    .from(invoiceStrayVoucher)
    .where(
      and(
        eq(invoiceStrayVoucher.pointOfSale, series.pointOfSale),
        eq(invoiceStrayVoucher.type, series.type),
      ),
    );
  return found?.highest ?? 0;
}

/** Whether the number is a remembered stray one: a voucher is there that no later invoice may adopt. */
export async function isStrayNumber(tx: Tx, series: SeriesRef, number: number): Promise<boolean> {
  const [found] = await tx
    .select({ id: invoiceStrayVoucher.id })
    .from(invoiceStrayVoucher)
    .where(
      and(
        eq(invoiceStrayVoucher.pointOfSale, series.pointOfSale),
        eq(invoiceStrayVoucher.type, series.type),
        eq(invoiceStrayVoucher.number, number),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/** A remembered number where a voucher MAY exist, and the invoice it was remembered for. */
export interface UnconfirmedStray {
  number: number;
  invoiceId: string;
}

/**
 * The remembered numbers of the series below `below` where a voucher may or may not exist, lowest
 * first, at most `limit` of them (JD-S4 R4-1).
 *
 * The numbering of the authority has no gaps. A remembered number is CONFIRMED once an invoice of the
 * series records a number that is higher or the same: the voucher is certainly there, and it is not
 * the one of an invoice that is asking now. Until then it is unconfirmed: the invoice it was
 * remembered for may never have been issued, and then the next voucher of the series takes that very
 * number, so the voucher of an invoice that asks now can be sitting under it. Numbers that are certain
 * by their reason (`orphaned`, `unmatched`) are never unconfirmed.
 */
export async function unconfirmedStraysBelow(
  tx: Tx,
  series: SeriesRef,
  below: number,
  limit: number,
): Promise<UnconfirmedStray[]> {
  const [recorded] = await tx
    .select({ highest: sql<number>`coalesce(max(${invoice.number}), 0)::int` })
    .from(invoice)
    .where(
      and(
        eq(invoice.pointOfSale, series.pointOfSale),
        eq(invoice.type, series.type),
        sql`${invoice.number} is not null`,
      ),
    );
  const confirmedUpTo = recorded?.highest ?? 0;
  return tx
    .select({ number: invoiceStrayVoucher.number, invoiceId: invoiceStrayVoucher.invoiceId })
    .from(invoiceStrayVoucher)
    .where(
      and(
        eq(invoiceStrayVoucher.pointOfSale, series.pointOfSale),
        eq(invoiceStrayVoucher.type, series.type),
        inArray(invoiceStrayVoucher.reason, [...UNCERTAIN_REASONS]),
        sql`${invoiceStrayVoucher.number} > ${confirmedUpTo}`,
        lt(invoiceStrayVoucher.number, below),
      ),
    )
    .orderBy(asc(invoiceStrayVoucher.number))
    .limit(limit);
}

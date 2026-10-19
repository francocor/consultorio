import { and, eq, sql } from 'drizzle-orm';

import { invoiceStrayVoucher } from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { CURRENT_TENANT } from './common.js';

/** The series a number belongs to: point of sale and voucher type (the organization is the context). */
export interface SeriesRef {
  pointOfSale: number;
  type: string;
}

/**
 * Remembers a number of the series that the authority may hold a voucher under and that no invoice
 * records (JD-S4 R3-3): the number an invoice expected when it was replaced without knowing whether it
 * had been issued, or the number of a voucher that arrived for an invoice somebody had closed.
 * Idempotent: a number is remembered once.
 */
export async function recordStrayVoucher(
  tx: Tx,
  invoiceId: string,
  series: SeriesRef,
  number: number,
  reason: 'replaced_unresolved' | 'orphaned',
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

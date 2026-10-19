import { and, eq, sql } from 'drizzle-orm';

import { invoice } from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The highest number that an invoice of the organization records for a point of sale and type, or 0.
 * It has the scope of the unique index of the numbers (organization, point of sale, type), NOT the series
 * of the authority: it is what an in-memory simulator that restarted must number after, so that a voucher
 * it issues never collides with one the organization holds. The real authority is asked for its own count
 * (`lastAuthorized`) and never needs this (JD-S4 R6-1).
 */
export async function highestNumberRecorded(
  tx: Tx,
  series: { pointOfSale: number; type: string },
): Promise<number> {
  const [found] = await tx
    .select({ highest: sql<number>`coalesce(max(${invoice.number}), 0)::int` })
    .from(invoice)
    .where(
      and(
        eq(invoice.pointOfSale, series.pointOfSale),
        eq(invoice.type, series.type),
        sql`${invoice.number} is not null`,
      ),
    );
  return found?.highest ?? 0;
}

import { and, eq, isNull, or, sql, type SQL } from 'drizzle-orm';

import { invoice } from '../../../db/schema/index.js';

/** What the authority numbers apart: the point of sale, the voucher type and the environment. */
export interface SeriesKey {
  pointOfSale: number;
  type: string;
  environment: string;
}

/**
 * The invoices of ONE series of the authority, as a condition on the `invoice` table. The authority
 * numbers per issuer CUIT, point of sale and voucher type (and environment), so the point of sale and
 * the type are not enough: an organization that changed its CUIT, or an invoice of another environment,
 * is another series (JD-S4 R5-B-T2).
 *
 * A voucher registered by hand carries the environment `production` whatever the point of sale says
 * (it came from the real tool of the authority), so it belongs to the series of its point of sale and
 * type by those two alone. An invoice without an issuer snapshot is not told apart by CUIT.
 */
export function inSeries(series: SeriesKey, issuerCuit: string): SQL {
  const condition = and(
    eq(invoice.pointOfSale, series.pointOfSale),
    eq(invoice.type, series.type),
    or(eq(invoice.environment, series.environment), eq(invoice.status, 'manual')),
    or(isNull(invoice.issuerSnapshot), sql`${invoice.issuerSnapshot}->>'cuit' = ${issuerCuit}`),
  );
  if (!condition) throw new Error('a series condition cannot be empty');
  return condition;
}

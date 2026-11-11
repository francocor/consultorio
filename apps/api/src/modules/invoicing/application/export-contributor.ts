import { asc, sql } from 'drizzle-orm';

import {
  fiscalProfile,
  invoice,
  invoiceDocument,
  invoiceLine,
  pointOfSale,
} from '../../../db/schema/index.js';
import {
  afterStamp,
  pagedByStamp,
  pagedRows,
  stampText,
  type ExportContributor,
} from '../../tenancy/index.js';

/** The hash that tells a retry from another request is internal: it does not leave with the export. */
function withoutHash<T extends { requestHash: string }>(entry: T): Omit<T, 'requestHash'> {
  const copy: Partial<T> = { ...entry };
  delete copy.requestHash;
  return copy as Omit<T, 'requestHash'>;
}

/** Where a line of an invoice is in the order of the export: its invoice and its position in it. */
interface LineCursor {
  invoiceId: string;
  position: number;
}

/**
 * Administrative export part owned by invoicing, for an organization that leaves: its fiscal profile
 * and points of sale, every invoice and credit note (and every attempt at one) with its lines, and
 * the metadata of the PDF of each (where it is stored, how big, whether it was delivered). The
 * certificate and its key are NEVER part of it: `fiscal_credential` is not read here at all, so no
 * column of it can leak, and the internal hash of a request is left out of the invoices. The tenancy
 * spec asks for the invoices in the export (JD-S4 R1-C5).
 *
 * The invoices, their lines and their documents grow with every charge, so they are read a page at a
 * time. The fiscal profile and the points of sale are a few rows and stay lists.
 */
export const exportInvoicing: ExportContributor = async ({ tx, pageSize }) => {
  const [profiles, points] = await Promise.all([
    tx.select().from(fiscalProfile).orderBy(asc(fiscalProfile.createdAt), asc(fiscalProfile.id)),
    tx.select().from(pointOfSale).orderBy(asc(pointOfSale.number)),
  ]);

  return {
    fiscalProfiles: profiles,
    pointsOfSale: points,
    invoices: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({ row: invoice, cursorAt: stampText(invoice.createdAt), cursorId: invoice.id })
          .from(invoice)
          .where(afterStamp(invoice.createdAt, invoice.id, after))
          .orderBy(asc(invoice.createdAt), asc(invoice.id))
          .limit(limit),
      project: ({ row }) => withoutHash(row),
    }),
    invoiceLines: pagedRows<typeof invoiceLine.$inferSelect, LineCursor>({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select()
          .from(invoiceLine)
          .where(
            after === null
              ? undefined
              : sql`(${invoiceLine.invoiceId}, ${invoiceLine.position}) > (${after.invoiceId}::uuid, ${after.position}::int)`,
          )
          .orderBy(asc(invoiceLine.invoiceId), asc(invoiceLine.position))
          .limit(limit),
      cursorOf: (row) => ({ invoiceId: row.invoiceId, position: row.position }),
    }),
    invoiceDocuments: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            row: invoiceDocument,
            cursorAt: stampText(invoiceDocument.createdAt),
            cursorId: invoiceDocument.id,
          })
          .from(invoiceDocument)
          .where(afterStamp(invoiceDocument.createdAt, invoiceDocument.id, after))
          .orderBy(asc(invoiceDocument.createdAt), asc(invoiceDocument.id))
          .limit(limit),
      project: ({ row }) => row,
    }),
  };
};

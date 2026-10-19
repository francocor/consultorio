import { asc } from 'drizzle-orm';

import {
  fiscalProfile,
  invoice,
  invoiceDocument,
  invoiceLine,
  pointOfSale,
} from '../../../db/schema/index.js';
import type { ExportContributor } from '../../tenancy/index.js';

/** The hash that tells a retry from another request is internal: it does not leave with the export. */
function withoutHash<T extends { requestHash: string }>(entry: T): Omit<T, 'requestHash'> {
  const copy: Partial<T> = { ...entry };
  delete copy.requestHash;
  return copy as Omit<T, 'requestHash'>;
}

/**
 * Administrative export part owned by invoicing, for an organization that leaves: its fiscal profile
 * and points of sale, every invoice and credit note (and every attempt at one) with its lines, and
 * the metadata of the PDF of each (where it is stored, how big, whether it was delivered). The
 * certificate and its key are NEVER part of it: `fiscal_credential` is not read here at all, so no
 * column of it can leak, and the internal hash of a request is left out of the invoices. The tenancy
 * spec asks for the invoices in the export (JD-S4 R1-C5).
 */
export const exportInvoicing: ExportContributor = async ({ tx }) => {
  const [profiles, points, invoices, lines, documents] = await Promise.all([
    tx.select().from(fiscalProfile).orderBy(asc(fiscalProfile.createdAt), asc(fiscalProfile.id)),
    tx.select().from(pointOfSale).orderBy(asc(pointOfSale.number)),
    tx.select().from(invoice).orderBy(asc(invoice.createdAt), asc(invoice.id)),
    tx.select().from(invoiceLine).orderBy(asc(invoiceLine.invoiceId), asc(invoiceLine.position)),
    tx
      .select()
      .from(invoiceDocument)
      .orderBy(asc(invoiceDocument.createdAt), asc(invoiceDocument.id)),
  ]);

  return {
    fiscalProfiles: profiles,
    pointsOfSale: points,
    invoices: invoices.map(withoutHash),
    invoiceLines: lines,
    invoiceDocuments: documents,
  };
};

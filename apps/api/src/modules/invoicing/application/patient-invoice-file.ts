import type { InvoiceType } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';

import { invoice, invoiceDocument } from '../../../db/schema/index.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { documentFileName } from './invoice-document.js';

/** The PDF of an invoice, as the patient portal needs it to hand it to the patient. */
export interface PatientInvoiceFile {
  invoiceId: string;
  objectKey: string;
  /** Made from the voucher (`factura-c-0005-00000077.pdf`); nothing a person typed reaches it. */
  fileName: string;
}

/**
 * The document of one invoice of one patient, or null (spec "Patient downloads own invoice"): the
 * invoice must be addressed to the patient themselves (a payer's is not theirs), issued, and have
 * its PDF. Anything else, including an invoice of another patient, is null: the portal answers it
 * as if it did not exist. The patient is an argument: the portal takes it from the session.
 */
export async function findInvoiceFileForPatient(
  tx: Tx,
  input: { invoiceId: string; patientId: string },
): Promise<PatientInvoiceFile | null> {
  const [row] = await tx
    .select({
      id: invoice.id,
      type: invoice.type,
      pointOfSale: invoice.pointOfSale,
      number: invoice.number,
      objectKey: invoiceDocument.objectKey,
    })
    .from(invoice)
    .innerJoin(invoiceDocument, eq(invoiceDocument.invoiceId, invoice.id))
    .where(
      and(
        eq(invoice.id, input.invoiceId),
        eq(invoice.patientId, input.patientId),
        eq(invoice.recipientKind, 'patient'),
        eq(invoice.status, 'issued'),
      ),
    );
  if (!row || row.number === null) return null;
  return {
    invoiceId: row.id,
    objectKey: row.objectKey,
    fileName: documentFileName(row.type as InvoiceType, row.pointOfSale, row.number),
  };
}

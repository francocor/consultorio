import { z } from 'zod';

import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import { storeInvoiceDocument, type PdfDeps } from '../application/invoice-document.js';
import { INVOICE_PDF_JOB } from '../application/job-names.js';

export { INVOICE_PDF_JOB };

export const InvoicePayload = JobPayload.extend({ invoiceId: z.uuid() });

/**
 * `invoice.pdf` (spec "Invoice document and delivery"): renders the PDF of an issued invoice, with
 * its QR, and stores it as `t/{tenantId}/invoices/{uuid}.pdf`. It is queued when the invoice is
 * issued. Its category is `export`: the document is built from a record the organization may read,
 * so it is also built in a read-only organization (the invoice may have been issued by the very
 * attempt that was still allowed to run).
 */
export function createInvoicePdfJob(deps: PdfDeps) {
  return defineJob({
    name: INVOICE_PDF_JOB,
    category: 'export',
    payload: InvoicePayload,
    async handler({ tx, tenantId, payload }) {
      await storeInvoiceDocument(tx, deps, { tenantId, invoiceId: payload.invoiceId });
    },
  });
}

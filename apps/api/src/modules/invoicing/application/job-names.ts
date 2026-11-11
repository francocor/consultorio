/** The queues of the invoicing module (declared in `platform/jobs/queues.ts` by the seam). */

/** Submits one pending invoice to the tax authority. */
export const AFIP_ISSUE_JOB = 'afip.issue';
/** Renders the PDF of an issued invoice and stores it. */
export const INVOICE_PDF_JOB = 'invoice.pdf';
/** Emails an issued invoice to its recipient. */
export const INVOICE_DELIVER_JOB = 'invoice.deliver';

import { eq } from 'drizzle-orm';

import { invoice, invoiceDocument } from '../../../db/schema/index.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { loadNoticeRecipient } from '../../notifications/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { INVOICE_DELIVER_JOB } from '../application/job-names.js';
import { loadOrganization } from '../application/settings.js';
import { renderInvoiceEmail } from '../domain/invoice-email.js';

import { InvoicePayload } from './invoice-pdf.js';

export { INVOICE_DELIVER_JOB };

export interface DeliverDeps {
  email: EmailSender;
  clock: () => Date;
}

/** Why an invoice was not sent, as the document records it. */
type SkippedReason = 'opted_out' | 'no_contact' | 'unreachable';

/**
 * `invoice.deliver` (spec "Invoice document and delivery"): emails an issued invoice to its
 * recipient when it is a patient. The notifications channel policy decides how: an invoice is email
 * only (WhatsApp is reserved for appointment reminders and waitlist offers), an opt-out or a
 * missing or failed address leaves nothing to send, and the reason is recorded. The email carries
 * the voucher and the amount, no clinical content and no line of the invoice. It is a message, so
 * it ends cancelled in a read-only organization and is never replayed.
 *
 * Safe to run again: the document records that it was sent (or why not), once.
 */
export function createInvoiceDeliverJob(deps: DeliverDeps) {
  return defineJob({
    name: INVOICE_DELIVER_JOB,
    category: 'write',
    payload: InvoicePayload,
    async handler({ tx, payload }) {
      const [row] = await tx.select().from(invoice).where(eq(invoice.id, payload.invoiceId));
      const [document] = await tx
        .select()
        .from(invoiceDocument)
        .where(eq(invoiceDocument.invoiceId, payload.invoiceId));
      if (!row || !document || row.number === null) return;
      if (document.deliveredAt !== null || document.deliverySkippedReason !== null) return;
      if (row.patientId === null) return;

      const recipient = await loadNoticeRecipient(tx, row.patientId, 'invoice');
      if (!recipient?.email) {
        const skipped = recipient?.skipped.find((entry) => entry.channel === 'email');
        const reason: SkippedReason =
          skipped?.reason === 'opted_out' || skipped?.reason === 'unreachable'
            ? skipped.reason
            : 'no_contact';
        await tx
          .update(invoiceDocument)
          .set({ deliverySkippedReason: reason })
          .where(eq(invoiceDocument.id, document.id));
        return;
      }

      const organization = await loadOrganization(tx);
      const rendered = renderInvoiceEmail({
        organizationName: await readOrganizationName(tx),
        givenNames: recipient.givenNames,
        type: row.type as Parameters<typeof renderInvoiceEmail>[0]['type'],
        pointOfSale: row.pointOfSale,
        number: row.number,
        totalCents: row.totalCents,
        testDocument: row.environment === 'homologation' || row.simulated,
      });
      // A failure here rolls the job back and it is tried again: the document is not marked.
      await deps.email.send({
        to: recipient.email,
        ...rendered,
        tenant: { id: organization.id, isDemo: organization.isDemo },
      });
      await tx
        .update(invoiceDocument)
        .set({ deliveredAt: deps.clock() })
        .where(eq(invoiceDocument.id, document.id));
    },
  });
}

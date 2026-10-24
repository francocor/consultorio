import type { PortalInvoiceDto } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { listInvoicesForPatient } from '../../invoicing/index.js';

import type { PortalSubject } from './subject.js';

/**
 * The invoices and credit notes addressed to the subject (spec "Consents, prescriptions and
 * invoices"). The invoicing module decides which ones are the patient's: only those addressed to
 * them, never the ones a payer owes, and only the ones that exist as documents. It writes the entry
 * of the read itself, with the patient as the actor.
 */
export async function readInvoices(
  tx: Tx,
  deps: { clock: () => Date },
  subject: PortalSubject,
  actor: AuditActor,
): Promise<PortalInvoiceDto[]> {
  const invoices = await listInvoicesForPatient(tx, deps, { patientId: subject.patientId, actor });
  return invoices.map((invoice) => ({
    id: invoice.id,
    kind: invoice.kind,
    type: invoice.type,
    pointOfSale: invoice.pointOfSale,
    number: invoice.number,
    issueDate: invoice.issueDate,
    totalCents: invoice.totalCents,
    hasPdf: invoice.hasPdf,
    testDocument: invoice.testDocument,
  }));
}

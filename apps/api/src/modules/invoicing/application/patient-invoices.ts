import type { InvoiceDto } from '@consultorio/contracts';
import { eq, inArray } from 'drizzle-orm';

import { invoice } from '../../../db/schema/index.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { loadInvoices } from './invoice-view.js';

/** Most invoices one read returns: a patient has a handful, and a portal page is not a report. */
const LIMIT = 200;

/**
 * The invoices of one patient, for the patient portal of Stage 5 (spec "Patient downloads own
 * invoice"): only the ones addressed to the patient themselves (an invoice to their payer is not
 * theirs to download), and only the ones that exist as documents: issued or registered ones, credit
 * notes included, newest first. A pending invoice has no number yet and a rejected attempt never
 * existed for the patient.
 *
 * Every read is audited, also when there is nothing to show (the audit trail says who looked at a
 * patient's billing). The actor is whoever reads: the portal passes the patient's own session.
 */
export async function listInvoicesForPatient(
  tx: Tx,
  deps: { clock: () => Date },
  input: { patientId: string; actor: AuditActor },
): Promise<InvoiceDto[]> {
  const { invoices } = await loadInvoices(
    tx,
    deps.clock,
    [
      eq(invoice.recipientKind, 'patient'),
      eq(invoice.patientId, input.patientId),
      inArray(invoice.status, ['issued', 'manual']),
    ],
    { limit: LIMIT },
  );
  await audit(tx, {
    action: 'patient.read',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'invoice',
    patientId: input.patientId,
    metadata: { scope: 'invoices', count: invoices.length },
  });
  return invoices;
}

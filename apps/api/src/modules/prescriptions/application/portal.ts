import type { PortalPrescriptionListing } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { can } from '../../../platform/authz/can.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { PrescriptionDenied } from './errors.js';
import { DOCUMENT_STATUSES } from './read-model.js';

/**
 * A prescription as the database gives it to the portal: the function `app.portal_prescriptions()`
 * (migration 0591), which answers only for the link and the identity the portal bound to the
 * transaction (`withPortalSubject`) and returns the confirmed prescriptions of that link's patient,
 * with no medication. The portal is not a professional, so the table itself is closed to it.
 */
interface PortalPrescriptionRow extends Record<string, unknown> {
  id: string;
  patient_id: string;
  /** The driver gives a timestamp of a raw statement as text. */
  issued_at: string | Date;
  status: PortalPrescriptionListing['status'];
  document_key: string | null;
}

/**
 * The prescriptions of one patient, for the patient portal (S5.08; e-prescription, "Patient access
 * and delivery"): the identifier of the record, the day it was issued and where it stands, never a
 * medication, and never a prescription the provider has not confirmed. Newest first.
 *
 * It runs on the transaction of the portal request, which holds the portal subject (JD-S5 R1-S5-1:
 * it never opens a second connection while the first is held). The patient is the subject of the
 * portal session: the portal decides it from the link the person picked and passes it here, and
 * nothing in a request can change it; the database answers for that link only, whatever is asked.
 * The portal actor must hold the permission to read prescriptions. The read is audited with the
 * actor the portal passes (an entry per read, also when there is nothing to show).
 */
export async function listPrescriptionsForPatient(
  tx: Tx,
  input: { actor: PortalActor; patientId: string; auditActor: AuditActor },
  options: { canRender?: boolean } = {},
): Promise<PortalPrescriptionListing[]> {
  const decision = can(input.actor, 'portal.prescription.read', { tenantId: input.actor.tenantId });
  if (!decision.allowed)
    throw new PrescriptionDenied(decision.reason, { patientId: input.patientId });

  const found = await tx.execute<PortalPrescriptionRow>(
    sql`select id, patient_id, issued_at, status, document_key from app.portal_prescriptions()`,
  );
  // Belt and braces: the function answers for the link bound to the transaction, and that link is
  // the subject's, so a row of another patient is a bug somewhere above and is dropped here.
  const rows = found.rows.filter((row) => row.patient_id === input.patientId);
  await audit(tx, {
    action: 'prescription.read',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'prescription',
    patientId: input.patientId,
    metadata: { via: 'portal', count: rows.length },
  });
  return rows.map((row) => ({
    id: row.id,
    issuedAt: new Date(row.issued_at).toISOString(),
    status: row.status,
    hasDocument:
      DOCUMENT_STATUSES.includes(row.status) &&
      (row.document_key !== null || options.canRender === true),
  }));
}

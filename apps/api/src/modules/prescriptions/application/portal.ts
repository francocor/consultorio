import type { PortalPrescriptionListing } from '@consultorio/contracts';
import { and, desc, eq, inArray } from 'drizzle-orm';

import { prescription } from '../../../db/schema/prescriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { PortalActor } from '../../../platform/authz/actor.js';
import { can } from '../../../platform/authz/can.js';
import { SYSTEM_USER_ID, type WithTenant } from '../../../platform/db/tenant-context.js';

import { PrescriptionDenied } from './errors.js';
import { DOCUMENT_STATUSES } from './read-model.js';

/** Most prescriptions one read returns: a patient has a handful, and a portal page is not a report. */
const LIMIT = 100;

/** The statuses the portal shows: a prescription the provider confirmed (issued or settled). */
const SHOWN = ['issued', 'cancelled', 'dispensed', 'expired'] as const;

/**
 * The prescriptions of one patient, for the patient portal (S5.08; e-prescription, "Patient access
 * and delivery"): the identifier of the record, the day it was issued and where it stands, never a
 * medication, and never a prescription the provider has not confirmed. Newest first.
 *
 * The patient is the subject of the portal session: the portal decides it from the link the person
 * picked and passes it here, and nothing in a request can change it. The portal actor must hold the
 * permission to read prescriptions. The read runs as the system on a connection of its own, because
 * the clinical policies of the database are for professionals, and is audited with the actor the
 * portal passes (an entry per read, also when there is nothing to show).
 */
export async function listPrescriptionsForPatient(
  withTenant: WithTenant,
  input: { actor: PortalActor; patientId: string; auditActor: AuditActor },
  options: { canRender?: boolean } = {},
): Promise<PortalPrescriptionListing[]> {
  const decision = can(input.actor, 'portal.prescription.read', { tenantId: input.actor.tenantId });
  if (!decision.allowed)
    throw new PrescriptionDenied(decision.reason, { patientId: input.patientId });

  return withTenant({ tenantId: input.actor.tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx
      .select({
        id: prescription.id,
        issuedAt: prescription.issuedAt,
        status: prescription.status,
        documentKey: prescription.documentKey,
      })
      .from(prescription)
      .where(
        and(eq(prescription.patientId, input.patientId), inArray(prescription.status, [...SHOWN])),
      )
      .orderBy(desc(prescription.issuedAt), desc(prescription.id))
      .limit(LIMIT);
    await audit(tx, {
      action: 'prescription.read',
      outcome: 'allow',
      actor: input.auditActor,
      resourceType: 'prescription',
      patientId: input.patientId,
      metadata: { via: 'portal', count: rows.length },
    });
    return rows.flatMap((row) =>
      row.issuedAt === null
        ? []
        : [
            {
              id: row.id,
              issuedAt: row.issuedAt.toISOString(),
              status: row.status as PortalPrescriptionListing['status'],
              hasDocument:
                DOCUMENT_STATUSES.includes(row.status as (typeof DOCUMENT_STATUSES)[number]) &&
                (row.documentKey !== null || options.canRender === true),
            },
          ],
    );
  });
}

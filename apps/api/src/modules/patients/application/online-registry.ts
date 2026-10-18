import { and, eq, sql } from 'drizzle-orm';

import { patient, patientVersion } from '../../../db/schema/patients.js';
import { dataProcessingConsent } from '../../../db/schema/privacy.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

import { snapshotOf } from './mapping.js';

/**
 * The part of the registry that the public online booking uses (online-booking, "Booking completion
 * and patient identification"). Nobody is signed in: the visitor proved only that they control an
 * email address, so these functions do the two things that need no trust and nothing else.
 *
 * - `findPatientByDocument` reads the identity ON FILE for a normalized document. The caller keeps it
 *   from the visitor: the booking never says whether the person already existed.
 * - `createOnlinePatient` registers a person nobody has registered, flagged "created online".
 *
 * Neither updates a record that exists: submitted data never overwrites what the organization
 * holds (patients, "Identity review of online matches").
 */

/** What is on file for a document, as the identity review shows it. */
export interface OnlinePatientMatch {
  id: string;
  givenNames: string;
  familyName: string;
  birthDate: string;
  phone: string | null;
  email: string | null;
  status: 'active' | 'inactive';
}

export async function findPatientByDocument(
  tx: Tx,
  document: { type: string; number: string },
): Promise<OnlinePatientMatch | null> {
  const [row] = await tx
    .select({
      id: patient.id,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      birthDate: patient.birthDate,
      phone: patient.phone,
      email: patient.email,
      status: patient.status,
    })
    .from(patient)
    .where(and(eq(patient.nationalIdType, document.type), eq(patient.nationalId, document.number)));
  return row ? { ...row, status: row.status === 'active' ? 'active' : 'inactive' } : null;
}

export interface NewOnlinePatient {
  /** The request that registers them: an anonymous visitor, so no user. */
  actor: AuditActor;
  givenNames: string;
  familyName: string;
  birthDate: string;
  /**
   * Already validated and normalized by the country rules. Null for a booking that cannot stand on
   * the record that has this document (the record is deactivated, or already carries all the
   * online appointments it may): the person gets a record of their own, without the document, and
   * reception decides what it is.
   */
  document: { type: string; number: string } | null;
  phone?: string | null;
  email: string;
  /** The text the visitor accepted; null when no consent record is to be written. */
  consent: { textKey: string; version: string } | null;
}

const UNIQUE_VIOLATION = '23505';

/**
 * Registers a patient from a verified public booking: origin `online`, version 1 of the history, an
 * audit entry that records the origin and no value, and the data-processing consent the visitor
 * accepted (recorded by the system, since nobody on the staff did).
 */
export async function createOnlinePatient(
  tx: Tx,
  input: NewOnlinePatient,
): Promise<{ id: string }> {
  let row: typeof patient.$inferSelect | undefined;
  try {
    [row] = await tx.transaction((inner) =>
      inner
        .insert(patient)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          familyName: input.familyName,
          givenNames: input.givenNames,
          birthDate: input.birthDate,
          nationalIdType: input.document?.type ?? null,
          nationalId: input.document?.number ?? null,
          phone: input.phone ?? null,
          email: input.email,
          origin: 'online',
        })
        .returning(),
    );
  } catch (error) {
    // Two registrations of the same document at the same moment: the second one loses.
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    if (cause?.code === UNIQUE_VIOLATION) throw new AppError('conflict');
    throw error;
  }
  if (!row) throw new Error('patient insert returned no row');

  await tx.insert(patientVersion).values({
    tenantId: sql`current_setting('app.tenant_id')::uuid`,
    patientId: row.id,
    version: row.version,
    changedBy: null,
    changedFields: [],
    snapshot: snapshotOf(row),
  });
  await audit(tx, {
    action: 'patient.created',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'patient',
    resourceId: row.id,
    patientId: row.id,
    metadata: { origin: 'online', hasDocument: input.document !== null },
  });
  if (input.consent) {
    const [consent] = await tx
      .insert(dataProcessingConsent)
      .values({
        tenantId: sql`current_setting('app.tenant_id')::uuid`,
        patientId: row.id,
        textKey: input.consent.textKey,
        textVersion: input.consent.version,
        recordedBy: SYSTEM_USER_ID,
      })
      .returning({ textVersion: dataProcessingConsent.textVersion });
    await audit(tx, {
      action: 'patient.consent.recorded',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'patient',
      resourceId: row.id,
      patientId: row.id,
      metadata: { textVersion: consent?.textVersion ?? input.consent.version },
    });
  }
  return { id: row.id };
}

import { inArray } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * How to reach a patient, and nothing else about them: the contact data that messaging needs
 * (reminders, confirmations, offers) without the rest of the demographics.
 */
export interface PatientContact {
  id: string;
  givenNames: string;
  familyName: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'inactive';
}

/** The contact data of the patients with these ids, in the organization of the transaction. */
export async function readPatientContacts(
  tx: Tx,
  patientIds: readonly string[],
): Promise<PatientContact[]> {
  if (patientIds.length === 0) return [];
  const rows = await tx
    .select({
      id: patient.id,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      email: patient.email,
      phone: patient.phone,
      status: patient.status,
    })
    .from(patient)
    .where(inArray(patient.id, [...patientIds]));
  return rows.map((row) => ({ ...row, status: row.status === 'active' ? 'active' : 'inactive' }));
}

/** The contact data of one patient, or null when there is no such patient in the organization. */
export async function readPatientContact(
  tx: Tx,
  patientId: string,
): Promise<PatientContact | null> {
  const [found] = await readPatientContacts(tx, [patientId]);
  return found ?? null;
}

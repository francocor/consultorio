import { eq } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * What the patient portal (Stage 5, track B) needs to know about a patient to invite them or to
 * link a dependent: who they are on the record, whether they have an email and a birth date. The
 * portal reads patients through here and not through the table.
 */
export interface PatientBasics {
  id: string;
  givenNames: string;
  familyName: string;
  /** `YYYY-MM-DD`. */
  birthDate: string;
  email: string | null;
  status: 'active' | 'inactive';
}

export async function readPatientBasics(tx: Tx, patientId: string): Promise<PatientBasics | null> {
  const [row] = await tx
    .select({
      id: patient.id,
      givenNames: patient.givenNames,
      familyName: patient.familyName,
      birthDate: patient.birthDate,
      email: patient.email,
      status: patient.status,
    })
    .from(patient)
    .where(eq(patient.id, patientId));
  return row ? { ...row, status: row.status === 'active' ? 'active' : 'inactive' } : null;
}

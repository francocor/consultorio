import { asc } from 'drizzle-orm';

import { patient, patientRepresentative } from '../../../db/schema/patients.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by patients: demographics and administrative contacts of
 * representatives. No clinical field exists in these tables, and the safety flag codes are left
 * out: they are derived from clinical content and travel only with the clinical part.
 */
export const exportPatients: ExportContributor = async ({ tx }) => {
  const patients = await tx
    .select({
      id: patient.id,
      familyName: patient.familyName,
      givenNames: patient.givenNames,
      birthDate: patient.birthDate,
      sex: patient.sex,
      documentType: patient.nationalIdType,
      document: patient.nationalId,
      phone: patient.phone,
      email: patient.email,
      address: patient.address,
      emergencyContactName: patient.emergencyContactName,
      emergencyContactPhone: patient.emergencyContactPhone,
      adminNotes: patient.adminNotes,
      status: patient.status,
      origin: patient.origin,
      registeredAt: patient.createdAt,
    })
    .from(patient)
    .orderBy(asc(patient.createdAt), asc(patient.id));

  const representatives = await tx
    .select({
      patientId: patientRepresentative.patientId,
      fullName: patientRepresentative.fullName,
      relation: patientRepresentative.relation,
      phone: patientRepresentative.phone,
      email: patientRepresentative.email,
      endedAt: patientRepresentative.endedAt,
    })
    .from(patientRepresentative)
    .orderBy(asc(patientRepresentative.createdAt));

  return { patients, representatives };
};

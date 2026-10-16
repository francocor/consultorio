import type { PatientDto, PatientSummaryDto } from '@consultorio/contracts';

import type { PatientRow } from '../../../db/schema/patients.js';

function documentOf(row: PatientRow): { type: string; number: string } | null {
  return row.nationalIdType !== null && row.nationalId !== null
    ? { type: row.nationalIdType, number: row.nationalId }
    : null;
}

function sexOf(row: PatientRow): PatientDto['sex'] {
  switch (row.sex) {
    case 'female':
    case 'male':
    case 'non_binary':
    case 'undisclosed':
      return row.sex;
    default:
      return null;
  }
}

export function toPatientDto(
  row: PatientRow,
  consentStatus: PatientDto['consentStatus'],
): PatientDto {
  const document = documentOf(row);
  return {
    id: row.id,
    familyName: row.familyName,
    givenNames: row.givenNames,
    birthDate: row.birthDate,
    sex: sexOf(row),
    document,
    noDocument: document === null,
    phone: row.phone,
    email: row.email,
    address: row.address,
    emergencyContact:
      row.emergencyContactName !== null && row.emergencyContactPhone !== null
        ? { name: row.emergencyContactName, phone: row.emergencyContactPhone }
        : null,
    adminNotes: row.adminNotes,
    status: row.status === 'active' ? 'active' : 'inactive',
    origin: row.origin === 'online' ? 'online' : 'staff',
    // Only THAT a flag exists. What it is about stays with the professionals.
    hasSafetyFlag: row.safetyFlags.length > 0,
    consentStatus,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toPatientSummary(row: PatientRow): PatientSummaryDto {
  return {
    id: row.id,
    familyName: row.familyName,
    givenNames: row.givenNames,
    birthDate: row.birthDate,
    document: documentOf(row),
    phone: row.phone,
    status: row.status === 'active' ? 'active' : 'inactive',
    hasSafetyFlag: row.safetyFlags.length > 0,
  };
}

/** The demographics as one version of the history keeps them. No clinical field exists to leak. */
export function snapshotOf(row: PatientRow): Record<string, unknown> {
  return {
    familyName: row.familyName,
    givenNames: row.givenNames,
    birthDate: row.birthDate,
    sex: row.sex,
    document: documentOf(row),
    phone: row.phone,
    email: row.email,
    address: row.address,
    emergencyContact:
      row.emergencyContactName !== null && row.emergencyContactPhone !== null
        ? { name: row.emergencyContactName, phone: row.emergencyContactPhone }
        : null,
    adminNotes: row.adminNotes,
    status: row.status,
  };
}

/** Names of the fields whose value differs between two snapshots, in a stable order. */
export function changedFieldsBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  return Object.keys(after).filter(
    (key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  );
}

import type { PatientDto, PatientSummaryDto } from '@consultorio/contracts';

/** Test data of the patient screens. */
export const PATIENT_IDS = {
  valentina: '0190a000-0000-7000-8000-0000000000e1',
  santiago: '0190a000-0000-7000-8000-0000000000e2',
  isabella: '0190a000-0000-7000-8000-0000000000e3',
  ian: '0190a000-0000-7000-8000-0000000000e4',
} as const;

export function summary(overrides: Partial<PatientSummaryDto> = {}): PatientSummaryDto {
  return {
    id: PATIENT_IDS.valentina,
    familyName: 'Gómez',
    givenNames: 'Valentina',
    birthDate: '1988-05-04',
    document: { type: 'dni', number: '99000001' },
    phone: '+54 11 0000 1234',
    status: 'active',
    hasSafetyFlag: false,
    ...overrides,
  };
}

export const SUMMARIES: PatientSummaryDto[] = [
  summary(),
  summary({
    id: PATIENT_IDS.santiago,
    familyName: 'Rodríguez',
    givenNames: 'Santiago',
    birthDate: '1975-02-10',
    document: { type: 'dni', number: '99000002' },
    phone: null,
    hasSafetyFlag: true,
  }),
  summary({
    id: PATIENT_IDS.ian,
    familyName: 'Navarro',
    givenNames: 'Ian',
    birthDate: '2025-11-20',
    document: null,
    phone: null,
  }),
];

export function patient(overrides: Partial<PatientDto> = {}): PatientDto {
  return {
    id: PATIENT_IDS.valentina,
    familyName: 'Gómez',
    givenNames: 'Valentina',
    birthDate: '1988-05-04',
    sex: 'female',
    document: { type: 'dni', number: '99000001' },
    noDocument: false,
    phone: '+54 11 0000 1234',
    email: 'valentina.gomez@demo.invalid',
    address: 'Calle Demo 123, Ciudad de Buenos Aires',
    emergencyContact: { name: 'Marta Gómez', phone: '+54 11 0000 9999' },
    adminNotes: 'Prefiere turnos por la tarde.',
    status: 'active',
    origin: 'staff',
    hasSafetyFlag: false,
    consentStatus: 'granted',
    version: 2,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    ...overrides,
  };
}

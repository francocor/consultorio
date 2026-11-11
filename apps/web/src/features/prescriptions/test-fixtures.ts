import type { PrescriptionCapabilityDto, PrescriptionDto } from '@consultorio/contracts';

export const ME_PROFESSIONAL = '0190a000-0000-7000-8000-0000000000f1';
export const OTHER_PROFESSIONAL = '0190a000-0000-7000-8000-0000000000f2';
export const PATIENT = '0190a000-0000-7000-8000-0000000000c1';

/** A prescription the provider issued, written by the professional who looks at it. */
export function prescription(overrides: Partial<PrescriptionDto> = {}): PrescriptionDto {
  return {
    id: '0190a000-0000-7000-8000-0000000000d1',
    patientId: PATIENT,
    encounterId: null,
    status: 'issued',
    date: '2026-10-19',
    createdAt: '2026-10-19T15:00:00.000Z',
    issuedAt: '2026-10-19T15:00:00.000Z',
    externalId: 'ERX-0123456789AB',
    registeredManually: false,
    prescriber: {
      professionalId: ME_PROFESSIONAL,
      fullName: 'Dra. Ana Gómez',
      matricula: 'MP 12345',
      jurisdiction: 'AR-B',
      specialty: 'Clínica médica',
    },
    patient: {
      fullName: 'Paula Pérez',
      documentType: 'dni',
      documentNumber: '30123456',
      coverage: null,
    },
    items: [
      {
        genericName: 'Amoxicilina',
        dose: '500 mg',
        form: 'comprimidos',
        quantity: 21,
        instructions: '1 cada 8 horas durante 7 días',
      },
    ],
    cancelReason: null,
    cancelledAt: null,
    failure: null,
    simulated: false,
    documentAvailable: true,
    ...overrides,
  };
}

/** One that waits for the provider. */
export function waiting(
  failure: Partial<NonNullable<PrescriptionDto['failure']>> = {},
  overrides: Partial<PrescriptionDto> = {},
): PrescriptionDto {
  return prescription({
    id: '0190a000-0000-7000-8000-0000000000d2',
    status: 'pending_submission',
    externalId: null,
    issuedAt: null,
    documentAvailable: false,
    failure: {
      kind: 'unavailable',
      message: null,
      attempts: 1,
      nextAttemptAt: '2026-10-19T15:01:00.000Z',
      awaitingReconciliation: false,
      ...failure,
    },
    ...overrides,
  });
}

/** One the provider refused. */
export function refused(overrides: Partial<PrescriptionDto> = {}): PrescriptionDto {
  return prescription({
    id: '0190a000-0000-7000-8000-0000000000d3',
    status: 'draft',
    externalId: null,
    issuedAt: null,
    documentAvailable: false,
    failure: {
      kind: 'rejected',
      message: 'Una línea de la receta no empieza con un nombre genérico del catálogo.',
      attempts: 1,
      nextAttemptAt: null,
      awaitingReconciliation: false,
    },
    ...overrides,
  });
}

export function capability(
  overrides: Partial<PrescriptionCapabilityDto> = {},
): PrescriptionCapabilityDto {
  return {
    professionalId: ME_PROFESSIONAL,
    providerAvailable: true,
    enabled: true,
    simulated: false,
    matriculaStatus: 'verified',
    canIssue: true,
    ...overrides,
  };
}

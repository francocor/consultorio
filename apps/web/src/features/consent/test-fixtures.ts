import type {
  ConsentListItemDto,
  ConsentSigningViewDto,
  ConsentTemplateDetailResponse,
  ConsentTemplateDto,
  ConsentTemplateVersionDto,
  SignedConsentDto,
} from '@consultorio/contracts';

export const PATIENT = '0190a000-0000-7000-8000-0000000000c1';
export const REQUEST = '0190a000-0000-7000-8000-0000000000d1';
export const TEMPLATE = '0190a000-0000-7000-8000-0000000000e1';
export const VERSION = '0190a000-0000-7000-8000-0000000000f1';

export const BODY = 'Autorizo la extracción de la muela del juicio.\n\nEntiendo los riesgos.';

export function item(overrides: Partial<ConsentListItemDto> = {}): ConsentListItemDto {
  return {
    id: REQUEST,
    status: 'signed',
    method: 'in_person',
    createdAt: '2031-03-01T12:00:00.000Z',
    expiresAt: '2031-03-15T12:00:00.000Z',
    signedAt: '2031-03-01T12:30:00.000Z',
    revokedAt: null,
    closedAt: null,
    title: null,
    versionNumber: null,
    canOpen: false,
    ...overrides,
  };
}

export function signingView(overrides: Partial<ConsentSigningViewDto> = {}): ConsentSigningViewDto {
  return {
    requestId: REQUEST,
    status: 'pending',
    method: 'in_person',
    expiresAt: '2031-03-15T12:00:00.000Z',
    patientName: 'Ana Pérez',
    requiresRepresentative: false,
    version: {
      id: VERSION,
      number: 3,
      title: 'Extracción de muela del juicio',
      body: BODY,
      contentHash: 'a'.repeat(64),
    },
    ...overrides,
  };
}

export function template(overrides: Partial<ConsentTemplateDto> = {}): ConsentTemplateDto {
  return {
    id: TEMPLATE,
    title: 'Extracción de muela del juicio',
    body: BODY,
    status: 'published',
    specialty: 'odontology',
    appointmentTypeId: null,
    starterKey: null,
    latestVersionNumber: 2,
    versionCount: 2,
    createdAt: '2031-02-01T12:00:00.000Z',
    updatedAt: '2031-02-10T12:00:00.000Z',
    retiredAt: null,
    ...overrides,
  };
}

export function version(
  overrides: Partial<ConsentTemplateVersionDto> = {},
): ConsentTemplateVersionDto {
  return {
    id: VERSION,
    templateId: TEMPLATE,
    number: 1,
    title: 'Extracción de muela del juicio',
    body: BODY,
    contentHash: 'b'.repeat(64),
    publishedAt: '2031-02-05T12:00:00.000Z',
    latest: false,
    ...overrides,
  };
}

export function detail(
  templateOverrides: Partial<ConsentTemplateDto> = {},
  versions: ConsentTemplateVersionDto[] = [
    version({ id: '0190a000-0000-7000-8000-0000000000f2', number: 2, latest: true }),
    version(),
  ],
): ConsentTemplateDetailResponse {
  return { template: template(templateOverrides), versions };
}

export function record(overrides: Partial<SignedConsentDto> = {}): SignedConsentDto {
  return {
    request: {
      id: REQUEST,
      patientId: PATIENT,
      templateId: TEMPLATE,
      versionId: VERSION,
      versionNumber: 3,
      status: 'signed',
      method: 'in_person',
      createdAt: '2031-03-01T12:00:00.000Z',
      expiresAt: '2031-03-15T12:00:00.000Z',
      signedAt: '2031-03-01T12:30:00.000Z',
      revokedAt: null,
      closedAt: null,
    },
    version: {
      id: VERSION,
      number: 3,
      title: 'Extracción de muela del juicio',
      body: BODY,
      contentHash: 'a'.repeat(64),
    },
    signerKind: 'patient',
    representative: null,
    mark: { kind: 'typed', name: 'Ana Pérez' },
    accepted: true,
    method: 'in_person',
    signedAt: '2031-03-01T12:30:00.000Z',
    contentFingerprint: 'c'.repeat(64),
    fingerprintValid: true,
    evidence: { ip: '203.0.113.9', userAgent: 'navegador', requestId: 'req-1' },
    revocation: null,
    ...overrides,
  };
}

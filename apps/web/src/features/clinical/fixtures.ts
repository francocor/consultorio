import type {
  AddendumDto,
  HistoryResponse,
  NoteDto,
  TimelineEntryDto,
  TimelineResponse,
} from '@consultorio/contracts';

export const CLINICAL_IDS = {
  note: '0190a000-0000-7000-8000-0000000000c1',
  encounter: '0190a000-0000-7000-8000-0000000000c2',
  patient: '0190a000-0000-7000-8000-0000000000c3',
  author: '0190a000-0000-7000-8000-0000000000c4',
  colleague: '0190a000-0000-7000-8000-0000000000c5',
  addendum: '0190a000-0000-7000-8000-0000000000c6',
} as const;

export const AUTHOR = { professionalId: CLINICAL_IDS.author, name: 'Dra. Lucía Paz Ferrer' };
export const COLLEAGUE = { professionalId: CLINICAL_IDS.colleague, name: 'Dr. Mateo Ruiz' };

const OWN_ACCESS = {
  basis: 'author' as const,
  canEdit: true,
  canSign: true,
  canAddAddendum: false,
  canMarkError: true,
  rectificationOnly: false,
};

/** A draft of the general template written by the signed-in professional. */
export function draftNote(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: CLINICAL_IDS.note,
    encounterId: CLINICAL_IDS.encounter,
    patientId: CLINICAL_IDS.patient,
    appointmentId: null,
    author: AUTHOR,
    status: 'draft',
    visibility: 'default',
    templateKind: 'general',
    templateVersion: 1,
    draftRevision: 0,
    content: {},
    derived: {},
    contentHash: null,
    createdAt: '2026-10-16T12:00:00.000Z',
    signedAt: null,
    error: null,
    addenda: [],
    access: OWN_ACCESS,
    ...overrides,
  };
}

export function signedNote(overrides: Partial<NoteDto> = {}): NoteDto {
  return draftNote({
    status: 'signed',
    content: {
      reasonForConsultation: 'Control de presión arterial',
      diagnosis: 'Hipertensión leve',
    },
    contentHash: 'a'.repeat(64),
    signedAt: '2026-10-16T12:30:00.000Z',
    access: { ...OWN_ACCESS, canEdit: false, canSign: false, canAddAddendum: true },
    ...overrides,
  });
}

export function addendum(overrides: Partial<AddendumDto> = {}): AddendumDto {
  return {
    id: CLINICAL_IDS.addendum,
    kind: 'correction',
    reason: 'Corrección del diagnóstico',
    text: 'El diagnóstico es hipertensión moderada',
    author: COLLEAGUE,
    createdAt: '2026-10-17T09:00:00.000Z',
    ...overrides,
  };
}

export function timelineEntry(overrides: Partial<TimelineEntryDto> = {}): TimelineEntryDto {
  return {
    noteId: CLINICAL_IDS.note,
    encounterId: CLINICAL_IDS.encounter,
    templateKind: 'general',
    templateVersion: 1,
    status: 'signed',
    visibility: 'default',
    author: AUTHOR,
    signedAt: '2026-10-16T12:30:00.000Z',
    createdAt: '2026-10-16T12:00:00.000Z',
    headline: 'Control de presión arterial',
    errorReason: null,
    addenda: [],
    basis: 'author',
    ...overrides,
  };
}

export function timeline(
  entries: TimelineEntryDto[] = [timelineEntry()],
  overrides: Partial<TimelineResponse> = {},
): TimelineResponse {
  return { entries, nextCursor: null, anamnesis: null, ...overrides };
}

export function history(): HistoryResponse {
  return {
    noteId: CLINICAL_IDS.note,
    items: [
      {
        type: 'version',
        versionNo: 1,
        templateVersion: 1,
        contentHash: 'b'.repeat(64),
        author: AUTHOR,
        at: '2026-10-16T12:30:00.000Z',
      },
      {
        type: 'addendum',
        id: CLINICAL_IDS.addendum,
        kind: 'correction',
        reason: 'Corrección del diagnóstico',
        contentHash: 'c'.repeat(64),
        author: COLLEAGUE,
        at: '2026-10-17T09:00:00.000Z',
      },
    ],
  };
}

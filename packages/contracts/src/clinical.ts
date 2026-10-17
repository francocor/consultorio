import { z } from 'zod';

import { CLINICAL_TEMPLATE_KINDS } from './access.js';
import {
  SURFACE_FINDINGS,
  TOOTH_CONDITIONS,
  TOOTH_SURFACES,
} from './clinical-templates/odontology.js';

/**
 * Clinical records over HTTP (clinical-records). These schemas carry clinical content, like the
 * anamnesis ones: only health professionals ever receive them.
 *
 * Requests that open or save an entry use plain objects (unknown members are dropped), because the
 * author, the organization and the time come from the session and the server clock and are never
 * read from a body (clinical-records, "Author cannot be spoofed").
 */

export const NOTE_STATUSES = ['draft', 'signed', 'entered_in_error'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const NOTE_VISIBILITIES = ['default', 'author_only'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

export const ADDENDUM_KINDS = ['correction', 'rectification'] as const;
export type AddendumKind = (typeof ADDENDUM_KINDS)[number];

export const TEMPLATE_KIND_SCHEMA = z.enum(CLINICAL_TEMPLATE_KINDS);

/** Content is a JSON object whose shape the template of the note decides. */
export const NoteContent = z.record(z.string(), z.unknown());
export type NoteContent = z.infer<typeof NoteContent>;

const Reason = z.string().trim().min(1).max(500);
const AddendumText = z.string().trim().min(1).max(4000);

// Requests ------------------------------------------------------------------------------------

export const OpenEncounterRequest = z.object({
  patientId: z.uuid(),
  templateKind: TEMPLATE_KIND_SCHEMA,
  /** Extension point: scheduling links the encounter to its appointment. */
  appointmentId: z.uuid().optional(),
  /** `author_only` restricts the entry to its author; it can be set now or while it is a draft. */
  visibility: z.enum(NOTE_VISIBILITIES).optional(),
});
export type OpenEncounterRequest = z.infer<typeof OpenEncounterRequest>;

export const SaveDraftRequest = z.object({
  content: NoteContent,
  /** The revision this edit started from (0 for a new draft). A newer one answers 409. */
  baseRevision: z.number().int().min(0),
  /** Changes the restriction to the author. Only a draft accepts it. */
  visibility: z.enum(NOTE_VISIBILITIES).optional(),
});
export type SaveDraftRequest = z.infer<typeof SaveDraftRequest>;

export const AddAddendumRequest = z.object({
  kind: z.enum(ADDENDUM_KINDS),
  reason: Reason,
  text: AddendumText,
});
export type AddAddendumRequest = z.infer<typeof AddAddendumRequest>;

export const MarkEnteredInErrorRequest = z.object({ reason: Reason });
export type MarkEnteredInErrorRequest = z.infer<typeof MarkEnteredInErrorRequest>;

const DateOnly = z.iso.date();

export const TimelineQuery = z.object({
  /** Entries marked in error are hidden unless asked for. */
  includeErrors: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Last note id of the previous page. */
  before: z.uuid().optional(),
});
export type TimelineQuery = z.infer<typeof TimelineQuery>;

/** At most this many entries of one patient are searched at once; more needs a date range. */
export const SEARCH_ENTRY_CAP = 2000;

export const ClinicalSearchQuery = z
  .object({
    q: z.string().trim().min(2).max(100),
    from: DateOnly.optional(),
    to: DateOnly.optional(),
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    path: ['to'],
    message: 'clinical.search.range_inverted',
  });
export type ClinicalSearchQuery = z.infer<typeof ClinicalSearchQuery>;

// Responses -----------------------------------------------------------------------------------

export const ClinicalAuthorDto = z.strictObject({
  professionalId: z.uuid(),
  /** How the member appears in the directory; null when none was set. */
  name: z.string().nullable(),
});
export type ClinicalAuthorDto = z.infer<typeof ClinicalAuthorDto>;

export const AddendumDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(ADDENDUM_KINDS),
  reason: z.string(),
  text: z.string(),
  author: ClinicalAuthorDto,
  createdAt: z.iso.datetime(),
});
export type AddendumDto = z.infer<typeof AddendumDto>;

/** Why this reader may open the entry; `shared` is read-only access through organization sharing. */
export const READ_BASES = ['author', 'treating', 'shared'] as const;

export const NoteAccessDto = z.strictObject({
  basis: z.enum(READ_BASES),
  canEdit: z.boolean(),
  canSign: z.boolean(),
  canAddAddendum: z.boolean(),
  canMarkError: z.boolean(),
  /** The organization is read-only: only a rectification addendum can be added (D16). */
  rectificationOnly: z.boolean(),
});
export type NoteAccessDto = z.infer<typeof NoteAccessDto>;

export const NoteErrorDto = z.strictObject({
  reason: z.string(),
  markedBy: ClinicalAuthorDto,
  markedAt: z.iso.datetime(),
});

export const NoteDto = z.strictObject({
  id: z.uuid(),
  encounterId: z.uuid(),
  patientId: z.uuid(),
  appointmentId: z.uuid().nullable(),
  author: ClinicalAuthorDto,
  status: z.enum(NOTE_STATUSES),
  visibility: z.enum(NOTE_VISIBILITIES),
  templateKind: TEMPLATE_KIND_SCHEMA,
  templateVersion: z.number().int().min(1),
  draftRevision: z.number().int().min(0),
  content: NoteContent,
  /** Computed by the server from the content (the body mass index); never stored or accepted. */
  derived: z.record(z.string(), z.unknown()),
  /** SHA-256 of the signed content; null while a draft. */
  contentHash: z.string().nullable(),
  createdAt: z.iso.datetime(),
  signedAt: z.iso.datetime().nullable(),
  error: NoteErrorDto.nullable(),
  addenda: z.array(AddendumDto),
  access: NoteAccessDto,
});
export type NoteDto = z.infer<typeof NoteDto>;

export const TemplateOfferDto = z.strictObject({
  kind: TEMPLATE_KIND_SCHEMA,
  version: z.number().int().min(1),
  labelKey: z.string(),
  requiredFields: z.array(z.string()),
});

export const TemplatesResponse = z.strictObject({ templates: z.array(TemplateOfferDto) });
export type TemplatesResponse = z.infer<typeof TemplatesResponse>;

export const TimelineEntryDto = z.strictObject({
  noteId: z.uuid(),
  encounterId: z.uuid(),
  templateKind: TEMPLATE_KIND_SCHEMA,
  templateVersion: z.number().int().min(1),
  status: z.enum(['signed', 'entered_in_error']),
  visibility: z.enum(NOTE_VISIBILITIES),
  author: ClinicalAuthorDto,
  signedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** The first line of what the entry says (reason for consultation, session...); null if none. */
  headline: z.string().nullable(),
  errorReason: z.string().nullable(),
  addenda: z.array(AddendumDto),
  basis: z.enum(READ_BASES),
});
export type TimelineEntryDto = z.infer<typeof TimelineEntryDto>;

export const TimelineResponse = z.strictObject({
  entries: z.array(TimelineEntryDto),
  nextCursor: z.uuid().nullable(),
  /** Whether the patient has an anamnesis. Its content is not repeated here, only linked. */
  anamnesis: z.strictObject({ version: z.number().int().min(1) }).nullable(),
});
export type TimelineResponse = z.infer<typeof TimelineResponse>;

export const SearchHitDto = z.strictObject({
  noteId: z.uuid(),
  encounterId: z.uuid(),
  templateKind: TEMPLATE_KIND_SCHEMA,
  author: ClinicalAuthorDto,
  signedAt: z.iso.datetime().nullable(),
  /** A short piece of the text around the match, with the words as written. */
  snippet: z.string(),
  inAddendum: z.boolean(),
});
export type SearchHitDto = z.infer<typeof SearchHitDto>;

export const SearchResponse = z.strictObject({
  hits: z.array(SearchHitDto),
  /** How many entries were looked through. */
  scanned: z.number().int().min(0),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const DraftSummaryDto = z.strictObject({
  noteId: z.uuid(),
  encounterId: z.uuid(),
  patientId: z.uuid(),
  patientName: z.string(),
  templateKind: TEMPLATE_KIND_SCHEMA,
  visibility: z.enum(NOTE_VISIBILITIES),
  draftRevision: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DraftSummaryDto = z.infer<typeof DraftSummaryDto>;

export const DraftsResponse = z.strictObject({ drafts: z.array(DraftSummaryDto) });
export type DraftsResponse = z.infer<typeof DraftsResponse>;

export const HistoryItemDto = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('version'),
    versionNo: z.number().int().min(1),
    templateVersion: z.number().int().min(1),
    contentHash: z.string(),
    author: ClinicalAuthorDto,
    at: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal('addendum'),
    id: z.uuid(),
    kind: z.enum(ADDENDUM_KINDS),
    reason: z.string(),
    /** SHA-256 of the addendum as stored (kind, reason and text). */
    contentHash: z.string(),
    author: ClinicalAuthorDto,
    at: z.iso.datetime(),
  }),
  z.strictObject({
    type: z.literal('entered_in_error'),
    reason: z.string(),
    author: ClinicalAuthorDto,
    at: z.iso.datetime(),
  }),
]);
export type HistoryItemDto = z.infer<typeof HistoryItemDto>;

export const HistoryResponse = z.strictObject({
  noteId: z.uuid(),
  items: z.array(HistoryItemDto),
});
export type HistoryResponse = z.infer<typeof HistoryResponse>;

const CurrentSurfaceDto = z.strictObject({
  finding: z.enum(SURFACE_FINDINGS).optional(),
  treatment: z.string().optional(),
});

export const CurrentToothDto = z.strictObject({
  condition: z.enum(TOOTH_CONDITIONS).optional(),
  surfaces: z.partialRecord(z.enum(TOOTH_SURFACES), CurrentSurfaceDto),
  note: z.string().optional(),
  /** The signature date of the entry that last said something about this tooth. */
  updatedAt: z.iso.datetime(),
  authorProfessionalId: z.uuid(),
});

/** The odontogram as it stands now, derived from the signed odontology entries the reader may see. */
export const CurrentOdontogramResponse = z.strictObject({
  teeth: z.record(z.string(), CurrentToothDto),
  /** How many signed entries the chart was derived from. */
  entries: z.number().int().min(0),
});
export type CurrentOdontogramResponse = z.infer<typeof CurrentOdontogramResponse>;

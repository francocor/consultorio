import { z } from 'zod';

/**
 * Contracts of the patients module: demographics, search, history and representatives. The tenant
 * is never a field. The safety flag is never an input anywhere: the system keeps it in step with
 * the anamnesis, and the only thing a client ever sees of it is that one exists.
 */

/** Documents a patient may have. The country pack decides what a valid number looks like. */
export const PATIENT_DOCUMENT_TYPES = ['dni', 'passport'] as const;
export type PatientDocumentType = (typeof PATIENT_DOCUMENT_TYPES)[number];

export const PATIENT_SEXES = ['female', 'male', 'non_binary', 'undisclosed'] as const;
export const PATIENT_STATUSES = ['active', 'inactive'] as const;
export const PATIENT_ORIGINS = ['staff', 'online'] as const;

const Name = z.string().trim().min(1).max(80);
const OptionalText = (max: number) => z.string().trim().max(max);
const Phone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9+()\-\s.]*$/, 'digits and phone punctuation only');
const IsoDate = z.iso.date();

export const DocumentInput = z.strictObject({
  type: z.enum(PATIENT_DOCUMENT_TYPES),
  number: z.string().trim().min(1).max(32),
});
export type DocumentInput = z.infer<typeof DocumentInput>;

export const EmergencyContact = z.strictObject({
  name: Name,
  phone: Phone.min(1),
});
export type EmergencyContact = z.infer<typeof EmergencyContact>;

const demographics = {
  familyName: Name,
  givenNames: Name,
  /** A patient without a document (a newborn) is registered with a name and a birth date. */
  birthDate: IsoDate,
  sex: z.enum(PATIENT_SEXES).optional(),
  /** Absent or `null`: the patient has no document yet; it can be added later. */
  document: DocumentInput.nullable().optional(),
  phone: Phone.optional(),
  email: z.string().trim().pipe(z.email().max(254)).optional(),
  address: OptionalText(300).optional(),
  emergencyContact: EmergencyContact.nullable().optional(),
  /** Administrative notes only. Clinical content lives in the clinical record, never here. */
  adminNotes: OptionalText(1000).optional(),
};

export const CreatePatientRequest = z.strictObject(demographics);
export type CreatePatientRequest = z.infer<typeof CreatePatientRequest>;

export const UpdatePatientRequest = z
  .strictObject({
    familyName: demographics.familyName.optional(),
    givenNames: demographics.givenNames.optional(),
    birthDate: demographics.birthDate.optional(),
    sex: demographics.sex,
    /** A document can be added or corrected, never removed: it is the identity key. */
    document: DocumentInput.optional(),
    phone: demographics.phone,
    email: demographics.email,
    address: demographics.address,
    emergencyContact: demographics.emergencyContact,
    adminNotes: demographics.adminNotes,
    /** Optimistic concurrency: the version the editor started from. A stale edit gets 409. */
    expectedVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (body) => Object.keys(body).some((key) => key !== 'expectedVersion'),
    'nothing to change',
  );
export type UpdatePatientRequest = z.infer<typeof UpdatePatientRequest>;

const DocumentDto = z.strictObject({ type: z.string(), number: z.string() });

/**
 * The minimal identity of a patient: what a list, a search result or a duplicate warning shows.
 * It has no clinical field, and `hasSafetyFlag` says only THAT a flag exists (the web app shows
 * the label "see professional"), never what it is about.
 */
export const PatientSummaryDto = z.strictObject({
  id: z.uuid(),
  familyName: z.string(),
  givenNames: z.string(),
  birthDate: z.string(),
  document: DocumentDto.nullable(),
  phone: z.string().nullable(),
  status: z.enum(PATIENT_STATUSES),
  hasSafetyFlag: z.boolean(),
});
export type PatientSummaryDto = z.infer<typeof PatientSummaryDto>;

export const PatientDto = z.strictObject({
  id: z.uuid(),
  familyName: z.string(),
  givenNames: z.string(),
  birthDate: z.string(),
  sex: z.enum(PATIENT_SEXES).nullable(),
  document: DocumentDto.nullable(),
  /** True when the patient has no identity document yet. */
  noDocument: z.boolean(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  emergencyContact: EmergencyContact.nullable(),
  adminNotes: z.string().nullable(),
  status: z.enum(PATIENT_STATUSES),
  origin: z.enum(PATIENT_ORIGINS),
  hasSafetyFlag: z.boolean(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PatientDto = z.infer<typeof PatientDto>;

/**
 * Answer to a creation. When the new patient has no document and a patient with the same name and
 * birth date exists, they are listed here: a warning, never a block.
 */
export const CreatePatientResponse = z.strictObject({
  patient: PatientDto,
  possibleDuplicates: z.array(PatientSummaryDto),
});
export type CreatePatientResponse = z.infer<typeof CreatePatientResponse>;

/** The 409 of a duplicate document: the problem plus the minimal identity of the existing patient. */
export const DuplicatePatientProblem = z.strictObject({
  type: z.string(),
  title: z.string(),
  status: z.literal(409),
  code: z.literal('conflict'),
  i18nKey: z.string(),
  requestId: z.string(),
  existingPatient: PatientSummaryDto,
});
export type DuplicatePatientProblem = z.infer<typeof DuplicatePatientProblem>;

export const PatientSearchQuery = z.strictObject({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(400).optional(),
});
export type PatientSearchQuery = z.infer<typeof PatientSearchQuery>;

export const PatientSearchResponse = z.strictObject({
  patients: z.array(PatientSummaryDto),
  nextCursor: z.string().nullable(),
});
export type PatientSearchResponse = z.infer<typeof PatientSearchResponse>;

export const PatientVersionDto = z.strictObject({
  version: z.number().int(),
  changedAt: z.iso.datetime(),
  changedBy: z.uuid().nullable(),
  changedFields: z.array(z.string()),
  /** The demographics as they were at that version. */
  snapshot: z.record(z.string(), z.unknown()),
});
export type PatientVersionDto = z.infer<typeof PatientVersionDto>;

export const PatientHistoryResponse = z.strictObject({ versions: z.array(PatientVersionDto) });
export type PatientHistoryResponse = z.infer<typeof PatientHistoryResponse>;

// Minors and representatives ----------------------------------------------------------------

export const REPRESENTATIVE_RELATIONS = ['mother', 'father', 'guardian', 'other'] as const;

export const RepresentativeInput = z
  .strictObject({
    fullName: Name,
    relation: z.enum(REPRESENTATIVE_RELATIONS),
    phone: Phone.min(1).optional(),
    email: z.string().trim().pipe(z.email().max(254)).optional(),
  })
  .refine((body) => body.phone !== undefined || body.email !== undefined, 'a way to reach them');
export type RepresentativeInput = z.infer<typeof RepresentativeInput>;

export const RepresentativeDto = z.strictObject({
  id: z.uuid(),
  fullName: z.string(),
  relation: z.enum(REPRESENTATIVE_RELATIONS),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  /** The day the patient reaches the age of majority: a reminder to review the arrangement. */
  majorityReviewOn: z.string(),
});
export type RepresentativeDto = z.infer<typeof RepresentativeDto>;

export const RepresentativeListResponse = z.strictObject({
  /** True when the patient is under the age of majority today. */
  minor: z.boolean(),
  representatives: z.array(RepresentativeDto),
});
export type RepresentativeListResponse = z.infer<typeof RepresentativeListResponse>;

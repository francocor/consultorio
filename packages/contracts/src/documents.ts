import { z } from 'zod';

/**
 * Documents (patient attachments): the limits, the whitelist of file types, the categories and the
 * request and response shapes. The API enforces the limits on the server, from the file content;
 * the web client uses the same constants only to tell the user early, never to decide.
 */

/** Largest file, in bytes (20 MB). The storage service enforces it on the upload itself. */
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

/** Most files in one upload request. */
export const DOCUMENT_MAX_FILES_PER_REQUEST = 10;

/** The file types a document may have, determined from content (never from the name). */
export const DOCUMENT_CONTENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
export type DocumentContentType = (typeof DOCUMENT_CONTENT_TYPES)[number];

export function isDocumentContentType(value: string): value is DocumentContentType {
  return DOCUMENT_CONTENT_TYPES.some((type) => type === value);
}

/** The usual file extension of each allowed type. */
export const DOCUMENT_EXTENSIONS: Record<DocumentContentType, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

// ---------------------------------------------------------------------------------------------
// Classification, categories and statuses
// ---------------------------------------------------------------------------------------------

/**
 * A document is clinical or administrative, decided by its category when it is uploaded. Clinical
 * documents follow the clinical-access rules (health professionals only); administrative ones
 * (ID copies, coverage cards, signed forms) are open to reception.
 */
export const DOCUMENT_CLASSIFICATIONS = ['clinical', 'administrative'] as const;
export type DocumentClassification = (typeof DOCUMENT_CLASSIFICATIONS)[number];

export const DOCUMENT_CATEGORIES = {
  clinical: ['lab_result', 'imaging', 'referral', 'clinical_report', 'other_clinical'],
  administrative: ['id_copy', 'coverage_card', 'signed_form', 'other_administrative'],
} as const;

export const ALL_DOCUMENT_CATEGORIES = [
  ...DOCUMENT_CATEGORIES.clinical,
  ...DOCUMENT_CATEGORIES.administrative,
] as const;
export type DocumentCategory = (typeof ALL_DOCUMENT_CATEGORIES)[number];

export function classificationOf(category: DocumentCategory): DocumentClassification {
  return DOCUMENT_CATEGORIES.clinical.some((clinical) => clinical === category)
    ? 'clinical'
    : 'administrative';
}

export function isClinicalCategory(category: DocumentCategory): boolean {
  return classificationOf(category) === 'clinical';
}

/**
 * `quarantined` until the scan passes, `available` once clean, `rejected` when infected or not
 * allowed, `hidden` when someone removed it from the default views. Nothing is ever deleted.
 */
export const DOCUMENT_STATUSES = ['quarantined', 'available', 'rejected', 'hidden'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Why a document was rejected. The web shows a message per reason; nothing else leaks. */
export const DOCUMENT_REJECTION_REASONS = [
  'infected',
  'type_not_allowed',
  'type_mismatch',
  'corrupt',
  'too_large',
] as const;
export type DocumentRejectionReason = (typeof DOCUMENT_REJECTION_REASONS)[number];

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

export const UploadFileSpec = z.strictObject({
  /** The name as the computer of the user shows it. Shown back as text; never used as a path. */
  name: z.string().min(1, 'required').max(255),
  /** The type the browser reports. Only a hint: the content decides, and a mismatch is refused. */
  contentType: z.enum(DOCUMENT_CONTENT_TYPES),
  size: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
  /** Hex SHA-256 computed in the browser, to warn about a duplicate before sending the file. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
});
export type UploadFileSpec = z.infer<typeof UploadFileSpec>;

export const CreateUploadsRequest = z
  .strictObject({
    patientId: z.uuid(),
    category: z.enum(ALL_DOCUMENT_CATEGORIES),
    /** Optional links. Both are extension points until encounters and appointments exist. */
    encounterId: z.uuid().optional(),
    appointmentId: z.uuid().optional(),
    /** A new version of this document. Needs exactly one file. */
    replacesDocumentId: z.uuid().optional(),
    files: z.array(UploadFileSpec).min(1).max(DOCUMENT_MAX_FILES_PER_REQUEST),
  })
  .refine((request) => request.replacesDocumentId === undefined || request.files.length === 1, {
    path: ['files'],
    message: 'a replacement is one file',
  });
export type CreateUploadsRequest = z.infer<typeof CreateUploadsRequest>;

export const HideDocumentRequest = z.strictObject({
  reason: z.string().trim().min(1).max(300),
});
export type HideDocumentRequest = z.infer<typeof HideDocumentRequest>;

export const ReclassifyDocumentRequest = z.strictObject({
  category: z.enum(ALL_DOCUMENT_CATEGORIES),
});
export type ReclassifyDocumentRequest = z.infer<typeof ReclassifyDocumentRequest>;

// ---------------------------------------------------------------------------------------------
// Responses. Lists carry metadata only: no content, no storage key, no hash of the content.
// ---------------------------------------------------------------------------------------------

export const DuplicateOf = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  uploadedAt: z.iso.datetime(),
});

export const PresignedUpload = z.strictObject({
  url: z.string().min(1),
  /** Form fields to send, in order, before the file part. */
  fields: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});

export const CreatedUpload = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  upload: PresignedUpload,
  /** A document with the same content already on this patient (only known when a hash was sent). */
  duplicateOf: DuplicateOf.nullable(),
});

export const CreateUploadsResponse = z.strictObject({
  uploads: z.array(CreatedUpload),
});
export type CreateUploadsResponse = z.infer<typeof CreateUploadsResponse>;

export const DocumentDto = z.strictObject({
  id: z.uuid(),
  patientId: z.uuid(),
  name: z.string(),
  category: z.enum(ALL_DOCUMENT_CATEGORIES),
  classification: z.enum(DOCUMENT_CLASSIFICATIONS),
  status: z.enum(DOCUMENT_STATUSES),
  /** The type found in the content once the scan has run; null while it is pending. */
  contentType: z.enum(DOCUMENT_CONTENT_TYPES).nullable(),
  size: z.number().int(),
  uploadedAt: z.iso.datetime(),
  uploadedByName: z.string().nullable(),
  rejectionReason: z.enum(DOCUMENT_REJECTION_REASONS).nullable(),
  encounterId: z.uuid().nullable(),
  appointmentId: z.uuid().nullable(),
  /** The version this one replaces. */
  replacesDocumentId: z.uuid().nullable(),
  /** How many versions exist in the chain this document heads (1 when it replaces nothing). */
  versionCount: z.number().int().min(1),
  /** Same content as an earlier document of this patient. */
  duplicateOf: DuplicateOf.nullable(),
  hidden: z.strictObject({ at: z.iso.datetime(), reason: z.string() }).nullable(),
  /**
   * True for a clinical document that reception sees only because the organization allows it:
   * name and category, no file. The web shows no download action for it.
   */
  metadataOnly: z.boolean(),
});
export type DocumentDto = z.infer<typeof DocumentDto>;

export const DocumentListResponse = z.strictObject({
  documents: z.array(DocumentDto),
});
export type DocumentListResponse = z.infer<typeof DocumentListResponse>;

export const DocumentVersionsResponse = z.strictObject({
  versions: z.array(DocumentDto),
});
export type DocumentVersionsResponse = z.infer<typeof DocumentVersionsResponse>;

export const DownloadLinkResponse = z.strictObject({
  /** A path on the same host: `/files/{token}`. Valid for five minutes, for this session only. */
  url: z.string().regex(/^\/files\/[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
});
export type DownloadLinkResponse = z.infer<typeof DownloadLinkResponse>;

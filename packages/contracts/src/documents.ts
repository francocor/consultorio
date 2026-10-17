/**
 * Documents (patient attachments): the limits and the whitelist of file types. The API enforces
 * them on the server, from the file content; the web client uses the same constants only to tell
 * the user early, never to decide.
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

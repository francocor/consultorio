import {
  DOCUMENT_MAX_BYTES,
  DOCUMENT_MAX_FILES_PER_REQUEST,
  isDocumentContentType,
  type DocumentContentType,
} from '@consultorio/contracts';

/** The little the browser tells us about a file. Everything else is up to the server. */
export interface PickedFile {
  name: string;
  size: number;
  type: string;
}

const BY_EXTENSION: Record<string, DocumentContentType> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * The type to ask the server for. The browser's own answer when it is an allowed type, otherwise
 * the one the extension suggests (some systems report nothing for a .docx). It is only a hint: the
 * server reads the bytes and refuses a file that is not what it claims to be.
 */
export function contentTypeOf(file: PickedFile): DocumentContentType | null {
  if (isDocumentContentType(file.type)) return file.type;
  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = file.name.slice(dot + 1).toLowerCase();
  // "archivo.pdf.exe": the last extension is the one that counts.
  return BY_EXTENSION[extension] ?? null;
}

export type FileRefusal = 'empty' | 'too_large' | 'type_not_allowed' | 'too_many';

export type FileCheck =
  | { ok: true; contentType: DocumentContentType }
  | { ok: false; reason: Exclude<FileRefusal, 'too_many'> };

/** Is this file worth sending? A wrong type is reported before a wrong size: it is what to fix first. */
export function checkFile(file: PickedFile): FileCheck {
  const contentType = contentTypeOf(file);
  if (contentType === null) return { ok: false, reason: 'type_not_allowed' };
  if (file.size < 1) return { ok: false, reason: 'empty' };
  if (file.size > DOCUMENT_MAX_BYTES) return { ok: false, reason: 'too_large' };
  return { ok: true, contentType };
}

export interface SelectionPlan<T extends PickedFile> {
  accepted: { file: T; contentType: DocumentContentType }[];
  refused: { name: string; reason: FileRefusal }[];
}

/**
 * Turns the files a person picked into those to upload and those refused, each with its reason.
 * One request takes at most ten files, counting the ones already waiting in the dialog.
 */
export function planSelection<T extends PickedFile>(
  files: readonly T[],
  waiting: number,
): SelectionPlan<T> {
  const plan: SelectionPlan<T> = { accepted: [], refused: [] };
  let room = Math.max(0, DOCUMENT_MAX_FILES_PER_REQUEST - waiting);
  for (const file of files) {
    const check = checkFile(file);
    if (!check.ok) {
      plan.refused.push({ name: file.name, reason: check.reason });
    } else if (room === 0) {
      plan.refused.push({ name: file.name, reason: 'too_many' });
    } else {
      room -= 1;
      plan.accepted.push({ file, contentType: check.contentType });
    }
  }
  return plan;
}

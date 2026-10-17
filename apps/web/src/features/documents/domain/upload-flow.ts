import type {
  CreateUploadsRequest,
  CreateUploadsResponse,
  DocumentCategory,
  DocumentContentType,
} from '@consultorio/contracts';

import type { StoragePost } from '../api/storage-upload.js';

/** The hash of a file in hexadecimal, or undefined where the browser cannot compute one. */
export async function sha256Hex(file: Blob): Promise<string | undefined> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  } catch {
    // An insecure context or an old browser: the duplicate warning is a courtesy, not a rule.
    return undefined;
  }
}

export interface RegisteredFile {
  documentId: string;
  post: StoragePost;
  /** The patient already has a file with this content. */
  duplicateOf: { id: string; name: string } | null;
}

export interface FlowApi {
  createUploads(request: CreateUploadsRequest): Promise<CreateUploadsResponse>;
}

export interface RegisterInput {
  patientId: string;
  category: DocumentCategory;
  replacesDocumentId?: string | undefined;
  entries: readonly { key: string; file: File; contentType: DocumentContentType }[];
}

/**
 * Asks the server to prepare the uploads of every file in ONE request (the server limits a request
 * to ten files and answers in the same order). Each file is sent with its hash so the server can
 * point out a duplicate before any byte travels. Returns the answers by the key of each entry.
 */
export async function registerFiles(
  api: FlowApi,
  input: RegisterInput,
  hash: (file: Blob) => Promise<string | undefined> = sha256Hex,
): Promise<Map<string, RegisteredFile>> {
  const hashes = await Promise.all(input.entries.map((entry) => hash(entry.file)));
  const response = await api.createUploads({
    patientId: input.patientId,
    category: input.category,
    ...(input.replacesDocumentId === undefined
      ? {}
      : { replacesDocumentId: input.replacesDocumentId }),
    files: input.entries.map((entry, index) => {
      const sha256 = hashes[index];
      return {
        name: entry.file.name,
        contentType: entry.contentType,
        size: entry.file.size,
        ...(sha256 === undefined ? {} : { sha256 }),
      };
    }),
  });

  const registered = new Map<string, RegisteredFile>();
  input.entries.forEach((entry, index) => {
    const upload = response.uploads[index];
    if (!upload) throw new Error('the server prepared fewer uploads than files');
    registered.set(entry.key, {
      documentId: upload.id,
      post: { url: upload.upload.url, fields: upload.upload.fields },
      duplicateOf: upload.duplicateOf
        ? { id: upload.duplicateOf.id, name: upload.duplicateOf.name }
        : null,
    });
  });
  return registered;
}

import type { Readable } from 'node:stream';

/**
 * Object storage port (design section 6, "ObjectStorage"). Documents and the logo of an
 * organization live here, never in the database. Everything is keyed under the tenant:
 * `t/{tenantId}/...`, so one organization's object cannot be named by another's code, and the
 * adapters refuse any key outside the prefix of the tenant that is asking.
 *
 * The adapters: S3 (MinIO locally, S3 in production) and an in-memory fake for tests.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_KEY_LENGTH = 1024;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** A key that is not inside the tenant's prefix, or is unsafe. The message never names the key. */
export class StorageKeyError extends Error {
  constructor() {
    super('storage key refused');
    this.name = 'StorageKeyError';
  }
}

function safeSegments(segments: readonly string[]): boolean {
  return (
    segments.length > 0 &&
    segments.every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('\\') &&
        !CONTROL_CHARACTERS.test(segment),
    )
  );
}

/** `t/{tenantId}/{parts...}`. Each part may contain `/`; none may escape the prefix. */
export function tenantKey(tenantId: string, ...parts: readonly string[]): string {
  if (!UUID.test(tenantId)) throw new StorageKeyError();
  const segments = parts.flatMap((part) => part.split('/'));
  if (!safeSegments(segments) || parts.some((part) => part.startsWith('/'))) {
    throw new StorageKeyError();
  }
  const key = `t/${tenantId}/${segments.join('/')}`;
  if (key.length > MAX_KEY_LENGTH) throw new StorageKeyError();
  return key;
}

/**
 * Checks that `key` is a well-formed key under the prefix of `tenantId`. Every adapter calls it
 * before touching storage, so a bug that passes another tenant's key (or `..`) fails closed.
 */
export function assertTenantKey(tenantId: string, key: string): void {
  if (!UUID.test(tenantId) || key.length > MAX_KEY_LENGTH) throw new StorageKeyError();
  const prefix = `t/${tenantId}/`;
  if (!key.startsWith(prefix) || key.length === prefix.length) throw new StorageKeyError();
  if (!safeSegments(key.slice(prefix.length).split('/'))) throw new StorageKeyError();
}

export interface PutObjectInput {
  body: Buffer | Readable;
  contentType: string;
  /** Required for a stream, optional for a buffer. */
  contentLength?: number;
}

export interface ObjectHead {
  size: number;
  contentType: string;
}

export interface StoredObject extends ObjectHead {
  stream: Readable;
}

export interface PresignedPostInput {
  contentType: string;
  /** The upload is refused by the storage service above this many bytes. */
  maxBytes: number;
  expiresInSeconds: number;
}

/** What a browser needs to upload straight to storage: a URL and the form fields to send with the file. */
export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectStorage {
  put(tenantId: string, key: string, input: PutObjectInput): Promise<void>;
  /** Null when the object does not exist. */
  get(tenantId: string, key: string): Promise<StoredObject | null>;
  /** Null when the object does not exist. */
  head(tenantId: string, key: string): Promise<ObjectHead | null>;
  /** A POST that lets a browser upload one object of one content type, with a size cap. */
  presignedPost(tenantId: string, key: string, input: PresignedPostInput): Promise<PresignedPost>;
  /** Moves an object inside the tenant's prefix. False when the source does not exist. */
  move(tenantId: string, fromKey: string, toKey: string): Promise<boolean>;
  /** Removes an object. Removing one that does not exist is not an error. */
  remove(tenantId: string, key: string): Promise<void>;
}

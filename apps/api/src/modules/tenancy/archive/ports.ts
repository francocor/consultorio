/**
 * The write-once store of the retention archive (Stage 6, tenancy: "Retention archive after
 * cancellation"). The records of a cancelled organization are encrypted, then written here and never
 * altered or deleted for the length of the retention period. The in-memory fake, the local MinIO
 * adapter (bucket with Object Lock in governance mode) and, later, S3 implement it; the shared suite
 * is `adapters/archive-store.contract.ts` (Track C, S6.09).
 *
 * The seam fixes only the shape the adapter resolver needs. The retention track (Track C) owns this
 * file from here on and may reshape it, as long as the fake keeps passing the suite it writes:
 *
 * - **Write once.** `put` of a key that exists with the same bytes is harmless (`already_stored`, so a
 *   retry after an unknown outcome is safe); the same key with other bytes is `locked`, never an
 *   overwrite. There is no way to replace an object through this port.
 * - **No delete through the routine role.** `remove` exists so that the immutability can be proven
 *   (the writer attempts it and is refused), not so that anything can be removed. Only the legal
 *   erasure procedure, with its own privileged credential and its own adapter instance, can remove an
 *   object, and it records the legal reference (`pnpm archive:legal-erase`).
 * - **The writer cannot read what it wrote.** Objects are encrypted with the public key of the
 *   organization before they get here; the private key is held only by the releaser process.
 * - **Every method takes an optional `AbortSignal`** and no database transaction is held while one
 *   waits (`CONNECTION_HOLDING_JOBS`): the object store is slow and large.
 */

export interface ArchiveObjectInfo {
  key: string;
  sizeBytes: number;
  /** Hex SHA-256 of the stored bytes (the ciphertext): the integrity check compares against it. */
  sha256: string;
  /** ISO instant until which the object cannot be altered or removed. */
  retainUntil: string;
  storedAt: string;
  /**
   * How many versions the store holds under the key. Always 1 for an object only this port wrote:
   * the port serves the ORIGINAL version, and more than one means something wrote under the key
   * behind the port's back (a credential that bypassed the `If-None-Match` of `put`). The original is
   * untouched (Object Lock); the verification reports the extra one as an attempt to overwrite.
   */
  versions: number;
}

export interface ArchivePutOptions {
  /** Hex SHA-256 of `body`. The store refuses bytes that do not match: a corrupted upload never lands. */
  sha256: string;
  retainUntil: Date;
}

export type ArchivePutResult =
  | { status: 'stored'; object: ArchiveObjectInfo }
  /** The key already holds exactly these bytes: a retry. */
  | { status: 'already_stored'; object: ArchiveObjectInfo }
  /** The key already holds other bytes. Write-once: nothing was changed. */
  | { status: 'locked'; message: string }
  | { status: 'rejected'; message: string }
  | { status: 'retryable'; message: string; outcomeUnknown: boolean };

export type ArchiveHeadResult =
  | { status: 'found'; object: ArchiveObjectInfo }
  | { status: 'unknown' }
  | { status: 'retryable'; message: string };

export type ArchiveGetResult =
  | { status: 'found'; object: ArchiveObjectInfo; body: Uint8Array }
  | { status: 'unknown' }
  | { status: 'retryable'; message: string };

export type ArchiveListResult =
  | { status: 'ok'; objects: readonly ArchiveObjectInfo[] }
  | { status: 'retryable'; message: string };

export type ArchiveRemoveResult =
  /** Inside the retention period: nobody removes it. */
  | { status: 'refused'; reason: 'retention' }
  /** Outside it, but this role may not remove objects. */
  | { status: 'refused'; reason: 'not_permitted' }
  | { status: 'unknown' }
  | { status: 'retryable'; message: string };

export interface ArchiveStore {
  put(
    key: string,
    body: Uint8Array,
    options: ArchivePutOptions,
    signal?: AbortSignal,
  ): Promise<ArchivePutResult>;
  head(key: string, signal?: AbortSignal): Promise<ArchiveHeadResult>;
  get(key: string, signal?: AbortSignal): Promise<ArchiveGetResult>;
  /** The objects whose key starts with the prefix, oldest first. */
  list(prefix: string, signal?: AbortSignal): Promise<ArchiveListResult>;
  /** Always refused for a routine role; the proof that the archive cannot be altered. */
  remove(key: string, signal?: AbortSignal): Promise<ArchiveRemoveResult>;
}

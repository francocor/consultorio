import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DEFAULT_LIMITS,
  discard,
  readArchive,
  readArchiveHeader,
  type ArchiveLimits,
} from './backup-archive.js';
import {
  BackupCryptoError,
  keyIdOf,
  unwrapBackupKey,
  type BackupHeader,
  type KeyWrap,
} from './backup-crypto.js';
import type { AdoptionPayload, Manifest } from './backup.js';
import { safeDestination } from './files.js';
import type { DataPaths } from './paths.js';
import { formatRecoveryKey } from './recovery-key.js';

export type RestoreErrorCode =
  /** The file is not a Consulvia backup. */
  | 'invalid_backup'
  /** The file is a backup that was changed, cut short or made with another key: nothing was read from it. */
  | 'tampered_backup'
  /** The backup was made by a newer version of Consulvia. */
  | 'newer_version'
  /** The backup belongs to another installation: its recovery key is needed. */
  | 'recovery_key_required'
  | 'wrong_recovery_key'
  | 'restore_failed';

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    readonly detail = '',
  ) {
    super(code);
    this.name = 'RestoreError';
  }
}

/** Reads what a backup says about itself (its header) without opening anything else. */
export async function readBackupInfo(path: string): Promise<{ header: BackupHeader }> {
  try {
    const { header } = await readArchiveHeader(path);
    return { header };
  } catch {
    throw new RestoreError('invalid_backup');
  }
}

/** What another install's backup hands over when it is restored here. */
export interface AdoptedSecrets {
  payload: AdoptionPayload;
  backupKeyBase64: string;
  backupKeyWrap: KeyWrap;
  /** The recovery key that was typed: from now on it is the key of this install. */
  recoveryKey: string;
}

export interface RestoreDeps {
  paths: DataPaths;
  /** The backup key of THIS install. */
  backupKey: () => Buffer;
  /**
   * Feeds a dump to `pg_restore`, which runs as `app_owner` (no superuser) into the scratch database with
   * `--no-owner`, in one transaction. Resolves when it has ended.
   */
  restoreDump: (source: Readable) => Promise<{ code: number | null; stderr: string }>;
  /**
   * The backup is restored into a database of its own, and that database replaces the real one only when
   * the restore has finished. Creating, renaming and dropping databases is the only thing done as the
   * superuser, and none of it uses anything from the backup.
   */
  scratch: {
    create: () => Promise<void>;
    swapIn: () => Promise<void>;
    drop: () => Promise<void>;
  };
  migrationCount: number;
  /** Stops the API and the worker. The database stays up. */
  stopServices: () => Promise<void>;
  /** Applies the migrations and starts the API and the worker again, with the secrets of the install as they are now. */
  startServices: () => Promise<void>;
  /** Makes the secrets of another install's backup the secrets of this one. Called after the data is in place. */
  adoptSecrets: (adopted: AdoptedSecrets) => Promise<void> | void;
  now: () => Date;
  limits?: ArchiveLimits;
  log?: (message: string) => void;
}

export interface RestoreOptions {
  /** Needed only when the backup belongs to another installation. */
  recoveryKey?: string;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RestoreError('invalid_backup');
  }
}

async function readSmall(data: AsyncIterable<Buffer>, limit = 256 * 1024): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of data) {
    size += part.length;
    if (size > limit) throw new RestoreError('invalid_backup', 'an entry is too large');
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

function asAdoption(value: unknown): AdoptionPayload {
  const object = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const text = (name: string) => {
    const field = object[name];
    if (typeof field !== 'string' || field === '') throw new RestoreError('invalid_backup');
    return field;
  };
  return {
    slug: text('slug'),
    kmsLocalKekBase64: text('kmsLocalKekBase64'),
    addressHashPepper: text('addressHashPepper'),
    storageUploadSecret: text('storageUploadSecret'),
    recoveryKeyHash: text('recoveryKeyHash'),
  };
}

function asManifest(value: unknown): Manifest {
  const object = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const { dumpBytes, dumpSha256, fileCount, fileBytes } = object;
  if (
    typeof dumpBytes !== 'number' ||
    typeof dumpSha256 !== 'string' ||
    typeof fileCount !== 'number' ||
    typeof fileBytes !== 'number'
  ) {
    throw new RestoreError('invalid_backup');
  }
  return { dumpBytes, dumpSha256, fileCount, fileBytes };
}

/** Which key opens this backup: this install's own, or the one the recovery key unwraps. */
function resolveKey(
  deps: RestoreDeps,
  header: BackupHeader,
  options: RestoreOptions,
): { key: Buffer; foreign: boolean } {
  const own = deps.backupKey();
  if (header.keyId === keyIdOf(own)) return { key: own, foreign: false };
  if (options.recoveryKey === undefined || options.recoveryKey.trim() === '') {
    throw new RestoreError('recovery_key_required');
  }
  let key: Buffer;
  try {
    key = unwrapBackupKey(header.wrap, options.recoveryKey);
  } catch {
    throw new RestoreError('wrong_recovery_key');
  }
  // A wrap that opens but names another key is not this backup's wrap.
  if (keyIdOf(key) !== header.keyId) throw new RestoreError('tampered_backup');
  return { key, foreign: true };
}

/**
 * Puts a backup in place of the data of this install. The caller has made a safety backup and asked the
 * owner to confirm. The order keeps the old data recoverable for as long as possible, and keeps anything
 * from the backup away from the live data until the whole file has proved itself:
 *
 * 1. the key is found, and every chunk of the file is authenticated: nothing is extracted before that;
 * 2. the dump goes straight into a scratch database through `pg_restore` (as `app_owner`, in one
 *    transaction) and the documents into a folder beside the live one;
 * 3. the documents folder is swapped, then the database.
 */
export async function restoreBackup(
  deps: RestoreDeps,
  archive: string,
  options: RestoreOptions = {},
): Promise<{ header: BackupHeader }> {
  const { header } = await readBackupInfo(archive);
  if (header.migrationCount > deps.migrationCount) throw new RestoreError('newer_version');
  const { key, foreign } = resolveKey(deps, header, options);
  const limits = deps.limits ?? DEFAULT_LIMITS;

  // Pass 1: the whole file must authenticate before anything is extracted or restored.
  try {
    await readArchive(
      archive,
      key,
      async (entry) => {
        await discard(entry.data);
      },
      { limits },
    );
  } catch (error) {
    if (error instanceof BackupCryptoError) {
      throw new RestoreError(
        error.code === 'invalid_header' ? 'invalid_backup' : 'tampered_backup',
      );
    }
    throw error;
  }

  const stamp = String(deps.now().getTime());
  const unpacked = join(deps.paths.root, `tmp-restore-${stamp}`);
  const unpackedFiles = join(unpacked, 'files');
  const aside = `${deps.paths.files}.replaced-${stamp}`;
  await mkdir(unpackedFiles, { recursive: true });
  const moved = { files: false };
  let servicesStopped = false;
  let scratchCreated = false;
  try {
    await deps.stopServices();
    servicesStopped = true;
    await deps.scratch.create();
    scratchCreated = true;

    // Pass 2: the work. The dump is piped into `pg_restore` as it is decrypted, and never written to disk.
    const found: {
      dump: { bytes: number; sha256: string } | null;
      manifest: Manifest | null;
      adopted: AdoptionPayload | null;
      fileCount: number;
    } = { dump: null, manifest: null, adopted: null, fileCount: 0 };
    await readArchive(
      archive,
      key,
      async (entry) => {
        if (entry.name === 'db.dump') {
          if (found.dump !== null) throw new RestoreError('invalid_backup', 'two dumps');
          const hash = createHash('sha256');
          let bytes = 0;
          const counted = Readable.from(
            (async function* () {
              for await (const part of entry.data) {
                hash.update(part);
                bytes += part.length;
                yield part;
              }
            })(),
          );
          const ended = await deps.restoreDump(counted);
          if (ended.code !== 0) {
            throw new RestoreError(
              'restore_failed',
              ended.stderr.trim().split(/\r?\n/).slice(-8).join('\n'),
            );
          }
          found.dump = { bytes, sha256: hash.digest('hex') };
        } else if (entry.name === 'secrets.json') {
          found.adopted = asAdoption(parseJson(await readSmall(entry.data)));
        } else if (entry.name === 'manifest.json') {
          found.manifest = asManifest(parseJson(await readSmall(entry.data)));
        } else if (entry.name.startsWith('files/')) {
          const target = safeDestination(unpackedFiles, entry.name.slice('files/'.length));
          if (target === null)
            throw new RestoreError('invalid_backup', 'a document outside its folder');
          await mkdir(dirname(target), { recursive: true });
          await pipeline(Readable.from(entry.data), createWriteStream(target));
          found.fileCount += 1;
        } else {
          throw new RestoreError('invalid_backup', `unexpected entry ${entry.name.slice(0, 40)}`);
        }
      },
      { limits, verifiedFirst: true },
    );

    const { manifest, dump, adopted } = found;
    if (
      manifest === null ||
      dump === null ||
      adopted === null ||
      manifest.dumpSha256 !== dump.sha256 ||
      manifest.dumpBytes !== dump.bytes ||
      manifest.fileCount !== found.fileCount
    ) {
      throw new RestoreError('invalid_backup', 'the manifest does not match the content');
    }

    // The documents: the old folder is moved aside, the unpacked one takes its place.
    try {
      await rename(deps.paths.files, aside);
      moved.files = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(unpackedFiles, deps.paths.files);

    // The database goes last: until here nothing of the live data was touched, and the documents can be put back.
    await deps.scratch.swapIn();
    scratchCreated = false;

    if (foreign && options.recoveryKey !== undefined) {
      await deps.adoptSecrets({
        payload: adopted,
        backupKeyBase64: key.toString('base64'),
        backupKeyWrap: header.wrap,
        recoveryKey: formatRecoveryKey(options.recoveryKey),
      });
    }
    deps.log?.('backup restored');
  } catch (error) {
    if (moved.files) {
      await rm(deps.paths.files, { recursive: true, force: true }).catch(() => undefined);
      await rename(aside, deps.paths.files).catch(() => undefined);
      moved.files = false;
    }
    throw error;
  } finally {
    if (scratchCreated) await deps.scratch.drop().catch(() => undefined);
    await rm(unpacked, { recursive: true, force: true }).catch(() => undefined);
    if (servicesStopped) await deps.startServices();
  }
  if (moved.files) await rm(aside, { recursive: true, force: true }).catch(() => undefined);
  return { header };
}

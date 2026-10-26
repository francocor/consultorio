import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import {
  DEFAULT_LIMITS,
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
import { DiskFullError, ensureRoom, freeBytes, isDiskFull } from './disk.js';
import { safeDestination } from './files.js';
import type { DataPaths } from './paths.js';
import { summarizePgError } from './pg-errors.js';
import { formatRecoveryKey } from './recovery-key.js';
import {
  clearJournal,
  removeQuietly,
  writeJournal,
  type Reconciled,
  type RestoreJournal,
  type RestoreStep,
} from './restore-journal.js';

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
  | 'restore_failed'
  /** The data is restored and in use, but the services could not be started again. Nothing was rolled back. */
  | 'restore_incomplete'
  /** The restore failed and putting everything back failed too: the next start finishes undoing it. */
  | 'undo_incomplete'
  /** The backup authenticated, but what it did to the database or the roles is not what a backup does. Nothing was kept. */
  | 'unsafe_backup';

export class RestoreError extends Error {
  constructor(
    readonly code: RestoreErrorCode,
    readonly detail = '',
    options?: ErrorOptions,
  ) {
    super(code, options);
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

/** The throwaway role a restore runs `pg_restore` as. The shell keeps what else it needs inside the same object. */
export interface ScratchHandle {
  user: string;
  password: string;
}

export interface RestoreDeps {
  paths: DataPaths;
  /** The backup key of THIS install. */
  backupKey: () => Buffer;
  /**
   * Feeds a dump to `pg_restore`, which runs as the throwaway role of this restore (`scratch.create`), into the
   * scratch database, with `--no-owner --no-privileges`, in one transaction. Resolves when it has ended.
   */
  restoreDump: (
    source: Readable,
    scratch: ScratchHandle,
  ) => Promise<{ code: number | null; stderr: string }>;
  /**
   * The backup is restored into a database of its own, and that database replaces the real one only when the
   * restore has finished.
   *
   * What a dump does is done by a role made for this restore alone, which owns the scratch database and nothing
   * else: it has no membership, no admin option and no power over any other role, so the cluster-wide effects a
   * hostile dump could have had (granting `audit_sealer`, changing the password of `app_owner`, setting parameters)
   * are refused by PostgreSQL itself, and what it can do to itself goes when the role is dropped.
   *
   * - `create` makes the role and the database, and reads the references the others compare with;
   * - `inspect` says what the dump did besides loading rows (a privilege, a parameter): any difference from the
   *   state the database started in was written by SQL hidden in the dump;
   * - `seal` hands the database to `app_owner`, gives it the grants of the live database, drops the role, and
   *   says what is still wrong. Neither runs code of the dump.
   */
  scratch: {
    create: () => Promise<ScratchHandle>;
    inspect: (scratch: ScratchHandle) => Promise<string[]>;
    seal: (scratch: ScratchHandle) => Promise<string[]>;
    swapIn: () => Promise<void>;
  };
  /**
   * Finishes or undoes the restore that the journal describes, from what is on the disk and in the cluster (see
   * `reconcileInterruptedRestore`): the same code that runs at every start after a crash, so a restore that
   * fails in this process and one that was cut off end up in the same place. `completed` means the databases
   * had in fact traded places.
   */
  reconcile: () => Promise<Reconciled>;
  /**
   * Facts about the cluster that a backup (a program for `pg_restore`, run as `app_owner`) must not change: who
   * is a member of `audit_sealer`, the parameters of the roles and of the database, the password of `app_owner`,
   * what the application may do to the audit trail, and that the table of the migrations is a table (see
   * `restore-audit.ts`). `snapshot` is read before the restore; `check` after it, before anything is swapped, and
   * says what is wrong; `revert` puts the roles back as the snapshot had them, and is run again after the swap.
   */
  audit: {
    snapshot: () => Promise<unknown>;
    check: (snapshot: unknown) => Promise<string[]>;
    revert: (snapshot: unknown) => Promise<void>;
  };
  migrationCount: number;
  /** Stops the API and the worker. The database stays up. */
  stopServices: () => Promise<void>;
  /** Applies the migrations and starts the API and the worker again, with the secrets of the install as they are now. */
  startServices: () => Promise<void>;
  /**
   * Makes the secrets of another install's backup the secrets of this one. Called BEFORE the databases trade
   * places, with `config.json` copied aside first so it can be put back.
   */
  adoptSecrets: (adopted: AdoptedSecrets) => Promise<void> | void;
  /** The size of the data of the install (database and documents), to know the room a restore needs. */
  dataBytes: () => Promise<number>;
  /** Free bytes where the data lives. Defaults to the real disk. */
  freeBytes?: (folder: string) => Promise<number>;
  now: () => Date;
  limits?: ArchiveLimits;
  log?: (message: string) => void;
  /** For the tests: called after each step of a restore, so one can stop there as a crash would. */
  checkpoint?: (point: RestoreCheckpoint) => Promise<void> | void;
}

export type RestoreCheckpoint =
  | 'prepared'
  | 'restoring'
  | 'files-swapping'
  | 'files-aside'
  | 'files-in-place'
  | 'files-swapped'
  | 'secrets-step'
  | 'secrets-adopted'
  | 'swapping'
  | 'swapped';

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
 * owner to confirm. The order keeps the old data recoverable for as long as possible, keeps anything from
 * the backup away from the live data until the whole file has proved itself, and is written in a journal
 * (`restore-journal.ts`) so a crash in the middle is finished or undone at the next start:
 *
 * 1. the key is found, and every chunk of the file is authenticated: nothing is extracted before that;
 * 2. there is room on the disk for the work;
 * 3. the dump goes straight into a scratch database through `pg_restore` (as `app_owner`, in one
 *    transaction) and the documents into a folder beside the live one;
 * 4. the documents folder is swapped, then the keys of another install's backup are adopted, then the
 *    databases trade places. That last step is the point of no return: from there nothing is rolled
 *    back, whatever fails afterwards, because the restored database is the real one.
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

  // Pass 1: the whole file must authenticate before anything is extracted or restored. It also measures what the
  // file expands to (the size of the file says little: documents and a dump compress, and a file made to be
  // opened expands far more), and stops reading as soon as that passes the free space on the disk, so a bomb
  // is cut at the size of the disk and not at the limit of the format.
  const free = await (deps.freeBytes ?? freeBytes)(deps.paths.root);
  const room = { folder: deps.paths.root, freeBytes: () => Promise.resolve(free) };
  const expanded = { dump: 0, files: 0, other: 0 };
  /** The dump is compressed (a custom format dump): the database it makes is several times larger. */
  const roomNeeded = () => Math.ceil(1.25 * (4 * expanded.dump + expanded.files + expanded.other));
  try {
    await readArchive(
      archive,
      key,
      async (entry) => {
        const kind =
          entry.name === 'db.dump' ? 'dump' : entry.name.startsWith('files/') ? 'files' : 'other';
        for await (const part of entry.data) {
          expanded[kind] += part.length;
          await ensureRoom({ ...room, needed: roomNeeded() });
        }
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

  // The scratch database and the unpacked documents are there at once, beside the data in use: what the file
  // expands to, and at least as much as the data in use now, which a restored install resembles.
  await ensureRoom({ ...room, needed: Math.max(roomNeeded(), await deps.dataBytes()) });

  const stamp = String(deps.now().getTime());
  const unpacked = join(deps.paths.root, `tmp-restore-${stamp}`);
  const unpackedFiles = join(unpacked, 'files');
  const aside = `${deps.paths.files}.replaced-${stamp}`;
  const configCopy = join(deps.paths.root, `config.json.pre-restore-${stamp}`);
  const hadFiles = await stat(deps.paths.files).then(
    () => true,
    () => false,
  );
  await mkdir(unpackedFiles, { recursive: true });
  const hasConfigCopy = await copyFile(deps.paths.configFile, configCopy).then(
    () => true,
    () => false,
  );
  const journal: RestoreJournal = {
    version: 1,
    stamp,
    step: 'prepared',
    filesAside: aside,
    unpacked,
    configCopy: hasConfigCopy ? configCopy : null,
    hadFiles,
    undoing: false,
  };
  const advance = async (step: RestoreStep) => {
    journal.step = step;
    await writeJournal(deps.paths, journal);
  };

  const reached = async (point: RestoreCheckpoint) => {
    await deps.checkpoint?.(point);
  };
  const state = { swapped: false };
  let servicesStopped = false;
  let snapshot: unknown;
  try {
    await advance('prepared');
    await reached('prepared');
    await deps.stopServices();
    servicesStopped = true;
    const scratch = await deps.scratch.create();
    await advance('restoring');
    await reached('restoring');
    snapshot = await deps.audit.snapshot();

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
          const ended = await deps.restoreDump(counted, scratch);
          if (ended.code !== 0) {
            // Not the tail of the error: it carries the rows pg_restore failed on, and this goes to the log.
            throw new RestoreError('restore_failed', summarizePgError(ended.stderr));
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

    // What the dump did besides loading rows, then the database is handed over to `app_owner` with the grants of the live
    // one. Both look at the catalogs only. The checks of the cluster after them are a second barrier: the role the
    // dump ran as could not have touched the roles of the application, and they say so.
    let problems = await deps.scratch.inspect(scratch);
    if (problems.length === 0) problems = await deps.scratch.seal(scratch);
    if (problems.length === 0) problems = await deps.audit.check(snapshot);
    if (problems.length > 0) {
      deps.log?.(`a backup was refused: ${problems.join('; ')}`);
      await deps.audit.revert(snapshot).catch(() => undefined);
      throw new RestoreError('unsafe_backup', problems.join('; '));
    }

    // The documents: the old folder is moved aside, the unpacked one takes its place. The journal says so
    // BEFORE the first rename, so that wherever a crash lands, the start after it finds the folder in place
    // missing, empty or the backup's, and the old one aside, and knows what to do with each.
    await advance('files-swapping');

    await reached('files-swapping');
    try {
      await rename(deps.paths.files, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await reached('files-aside');
    await rename(unpackedFiles, deps.paths.files);
    await reached('files-in-place');
    await advance('files-swapped');
    await reached('files-swapped');

    // The keys of another install's backup are adopted BEFORE the databases trade places, with a way back:
    // the other order leaves a restored database that the keys on disk cannot read if this step fails.
    if (foreign && options.recoveryKey !== undefined) {
      await advance('secrets-adopted');
      await reached('secrets-step');
      await deps.adoptSecrets({
        payload: adopted,
        backupKeyBase64: key.toString('base64'),
        backupKeyWrap: header.wrap,
        recoveryKey: formatRecoveryKey(options.recoveryKey),
      });
      await reached('secrets-adopted');
    }

    // The point of no return: after this the restored database is the real one.
    await advance('swapping');
    await reached('swapping');
    await deps.scratch.swapIn();
    state.swapped = true;
    await reached('swapped');
  } catch (error) {
    // Everything that is not the restored database is put back by the same code that runs at every start. If the
    // databases did in fact trade places (an error after the rename), that code finishes the restore instead.
    let finished = false;
    let unreadable = false;
    if (!state.swapped) {
      try {
        const outcome = await deps.reconcile();
        finished = outcome === 'completed';
        unreadable = outcome === 'unreadable';
      } catch (undoError) {
        const detail = undoError instanceof Error ? undoError.message : String(undoError);
        deps.log?.(`the failed restore could not be undone completely: ${detail}`);
        // The journal and the copies stay where they are: the next start finishes the job. Nothing is started
        // on top of a half undone restore.
        throw new RestoreError('undo_incomplete', detail, { cause: undoError });
      }
    }
    if (unreadable) {
      const detail = 'restore-journal.json cannot be read';
      deps.log?.(detail);
      throw new RestoreError('undo_incomplete', detail);
    }
    if (!finished) {
      await restart(deps, servicesStopped);
      throw isDiskFull(error) && !(error instanceof DiskFullError)
        ? new DiskFullError(0, 0)
        : error;
    }
    deps.log?.('the databases had traded places although the swap reported an error');
  }

  // From here the restored data is the data of the install: what is left is housekeeping, and starting. The
  // journal goes first: a crash after it leaves garbage that the next start sweeps, not a start that fails.
  await clearJournal(deps.paths).catch(() => undefined);
  // The roles are as they were before: said again, in case anything touched them since the check.
  await deps.audit.revert(snapshot).catch(() => undefined);
  await removeQuietly(unpacked);
  await removeQuietly(aside);
  if (hasConfigCopy) await removeQuietly(configCopy);
  deps.log?.('backup restored');
  try {
    await deps.startServices();
  } catch (error) {
    // The data is restored; only the start failed. Nothing is rolled back: the next start brings it up.
    throw new RestoreError(
      'restore_incomplete',
      error instanceof Error ? error.message : String(error),
    );
  }
  return { header };
}

/** Starts the services again after a restore that failed, and never hides the failure that came first. */
async function restart(deps: RestoreDeps, stopped: boolean): Promise<void> {
  if (!stopped) return;
  try {
    await deps.startServices();
  } catch (error) {
    deps.log?.(
      `the services did not start after a failed restore: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

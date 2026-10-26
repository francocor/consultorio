import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';

import { createArchiveWriter, discard, readArchive, readArchiveHeader } from './backup-archive.js';
import {
  FORMAT,
  keyIdOf,
  type BackupHeader,
  type BackupKind,
  type KeyWrap,
} from './backup-crypto.js';
import {
  forgetBackups,
  readLedger,
  readRejected,
  recordVerified,
  rememberRejected,
  sha256OfFile,
} from './backup-ledger.js';
import { DiskFullError, ensureRoom, isDiskFull } from './disk.js';
import { isBackupFile, listFiles, sizeOf } from './files.js';
import type { DataPaths } from './paths.js';
import { summarizePgError } from './pg-errors.js';

export type { BackupKind };

/** The extension of a backup: a Consulvia backup, encrypted and authenticated (`backup-crypto.ts`). */
export const BACKUP_EXTENSION = '.cvb';

/** What goes in `secrets.json` of a backup: what another install needs to read the clinical data. */
export interface AdoptionPayload {
  slug: string;
  kmsLocalKekBase64: string;
  addressHashPepper: string;
  storageUploadSecret: string;
  /** To check, later, the recovery key that is typed. */
  recoveryKeyHash: string;
}

/** The last entry of a backup: what must be true of everything before it. */
export interface Manifest {
  dumpBytes: number;
  dumpSha256: string;
  fileCount: number;
  fileBytes: number;
}

/** A running `pg_dump` whose standard output is the dump. */
export interface DumpProcess {
  stdout: Readable;
  /** Resolves when it has ended, with its exit code and the tail of its error output. */
  finished: Promise<{ code: number | null; stderr: string }>;
}

export interface BackupDeps {
  paths: DataPaths;
  /** Starts `pg_dump --format=custom` of the database to its standard output. */
  startDump: () => DumpProcess;
  /** `pg_restore --list` fed with a dump: proves the program that will restore it can read it. */
  listDump: (source: Readable) => Promise<{ code: number | null; stderr: string }>;
  backupKey: () => Buffer;
  keyWrap: () => KeyWrap;
  secrets: () => AdoptionPayload;
  /** The size of the data of the install (database and documents), to know the room a backup needs. */
  dataBytes: () => Promise<number>;
  /** Free bytes where the backups are written. Defaults to the real disk. */
  freeBytes?: (folder: string) => Promise<number>;
  appVersion: string;
  migrationCount: number;
  now: () => Date;
  log?: (message: string) => void;
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** `2026-10-24_1530` in local time. The name sorts by time. */
export function stamp(date: Date): string {
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/** `2026-10-24`, the local date: what "once a day" is counted in. */
export function localDay(date: Date): string {
  return stamp(date).slice(0, 10);
}

const KIND_NAMES: Record<BackupKind, string> = {
  daily: 'diaria',
  manual: 'manual',
  safety: 'previa-restauracion',
  upgrade: 'previa-actualizacion',
};

export function backupFileName(kind: BackupKind, date: Date): string {
  return `consulvia-${KIND_NAMES[kind]}-${stamp(date)}${BACKUP_EXTENSION}`;
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly detail = '',
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

// The error of a dump tool can quote rows of the database: only what failed is kept (see `pg-errors.ts`).
const tailOf = summarizePgError;

/** Copies `data` into a stream for a program that may stop reading it early, and reads the rest itself. */
function feed(data: AsyncIterable<Buffer>, sink: PassThrough): Promise<void> {
  return (async () => {
    try {
      for await (const part of data) {
        if (sink.destroyed) continue;
        if (!sink.write(part)) await Promise.race([once(sink, 'drain'), once(sink, 'close')]);
      }
    } finally {
      if (!sink.destroyed) sink.end();
    }
  })();
}

/**
 * Opens a backup again and proves it is whole: every chunk authenticates, the dump matches the manifest, and
 * `pg_restore --list` can read the dump. Writing a file is not the same as having a backup.
 */
export async function verifyBackupFile(
  deps: Pick<BackupDeps, 'backupKey' | 'listDump'>,
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const key = deps.backupKey();
  const found: { dumpSha256: string | null; dumpBytes: number; manifest: Manifest | null } = {
    dumpSha256: null,
    dumpBytes: 0,
    manifest: null,
  };
  try {
    // Reads the whole file once to authenticate it, then once more for the handler.
    await readArchive(path, key, async (entry) => {
      if (entry.name === 'db.dump') {
        const hash = createHash('sha256');
        for await (const part of entry.data) {
          hash.update(part);
          found.dumpBytes += part.length;
        }
        found.dumpSha256 = hash.digest('hex');
      } else if (entry.name === 'manifest.json') {
        const parts: Buffer[] = [];
        for await (const part of entry.data) parts.push(part);
        found.manifest = JSON.parse(Buffer.concat(parts).toString('utf8')) as Manifest;
      } else {
        await discard(entry.data);
      }
    });
    await readArchive(
      path,
      key,
      async (entry) => {
        if (entry.name !== 'db.dump') return;
        const sink = new PassThrough();
        const feeding = feed(entry.data, sink);
        const listed = await deps.listDump(sink);
        await feeding;
        if (listed.code !== 0) {
          throw new BackupError('pg_restore cannot read the dump', tailOf(listed.stderr));
        }
      },
      { verifiedFirst: true },
    );
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(
      'The backup does not authenticate',
      error instanceof Error ? error.message : String(error),
    );
  }
  const { manifest } = found;
  if (
    manifest === null ||
    found.dumpSha256 === null ||
    manifest.dumpSha256 !== found.dumpSha256 ||
    manifest.dumpBytes !== found.dumpBytes
  ) {
    throw new BackupError('The manifest does not match the dump');
  }
  return { sha256: await sha256OfFile(path), bytes: (await stat(path)).size };
}

/**
 * A backup is one file: the dump of the database (`pg_dump -Fc`, streamed, never written plain to disk),
 * the whole `files` folder, the secrets another install needs to read it, and a manifest, all encrypted and
 * authenticated with the key of the install. It is written to a temporary name, renamed when complete, and
 * then opened again and verified: only a backup that passed is entered in the ledger and counts as a copy.
 */
export async function createBackup(
  deps: BackupDeps,
  kind: BackupKind,
): Promise<{ path: string; bytes: number }> {
  const started = deps.now();
  const name = backupFileName(kind, started);
  const target = join(deps.paths.backups, name);
  await mkdir(deps.paths.backups, { recursive: true });
  // The copy is about as big as the data, and the work in progress needs as much again.
  await ensureRoom({
    folder: deps.paths.backups,
    needed: 2 * (await deps.dataBytes()),
    ...(deps.freeBytes ? { freeBytes: deps.freeBytes } : {}),
  });
  const key = deps.backupKey();

  // The API moves a document between folders when its scan ends. If one moves between the listing and the
  // read, the archive is made again: a document must never be left out of a backup silently.
  for (let attempt = 1; ; attempt += 1) {
    const header: BackupHeader = {
      format: FORMAT,
      createdAt: started.toISOString(),
      appVersion: deps.appVersion,
      migrationCount: deps.migrationCount,
      kind,
      keyId: keyIdOf(key),
      fileSalt: randomBytes(32).toString('base64'),
      wrap: deps.keyWrap(),
    };
    const writer = createArchiveWriter(target, key, header);
    try {
      const dump = deps.startDump();
      dump.finished.catch(() => undefined);
      const streamed = await writer.addStream('db.dump', dump.stdout);
      const ended = await dump.finished;
      if (ended.code !== 0 || streamed.bytes === 0) {
        throw new BackupError('The database dump failed', tailOf(ended.stderr));
      }
      await writer.addBuffer('secrets.json', JSON.stringify(deps.secrets()));
      const documents = await listFiles(deps.paths.files, 'files/', isBackupFile);
      let fileBytes = 0;
      for (const document of documents) {
        fileBytes += await sizeOf(document.file);
        await writer.addFile(document.name, document.file);
      }
      const manifest: Manifest = {
        dumpBytes: streamed.bytes,
        dumpSha256: streamed.sha256,
        fileCount: documents.length,
        fileBytes,
      };
      await writer.addBuffer('manifest.json', JSON.stringify(manifest));
      await writer.finish();
    } catch (error) {
      await writer.abort();
      if (isDiskFull(error)) throw new DiskFullError(0, 0);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 3) throw error;
      deps.log?.('a document moved while the backup was being written; trying again');
      continue;
    }

    try {
      const verified = await verifyBackupFile(deps, target);
      deps.log?.(`backup written and verified: ${target} (${String(verified.bytes)} bytes)`);
      // A ledger that cannot be written (a file an antivirus holds, a disk that is full) leaves a good backup that
      // is simply not counted as verified: it is never pruned, which is the safe side, and it is not thrown away.
      try {
        await recordVerified(deps.paths.backups, name, {
          sha256: verified.sha256,
          bytes: verified.bytes,
          verifiedAt: deps.now().toISOString(),
        });
      } catch (error) {
        deps.log?.(
          `the ledger of verified backups could not be written: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { path: target, bytes: verified.bytes };
    } catch (error) {
      // A file that did not pass is not a backup: it must not stay where it could be taken for one.
      await rm(target, { force: true });
      throw error;
    }
  }
}

/** The backups in `directory` that the ledger does not vouch for (no entry, or an entry for a file of another size), newest first. */
export async function unledgeredBackups(directory: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const pattern = new RegExp(
    `^consulvia-(?:${Object.values(KIND_NAMES).join('|')})-\\d{4}-\\d{2}-\\d{2}_\\d{4}\\${BACKUP_EXTENSION}$`,
  );
  const ledger = await readLedger(directory);
  const rejected = await readRejected(directory);
  const pending: string[] = [];
  for (const name of names.filter((candidate) => pattern.test(candidate))) {
    const size = await sizeOf(join(directory, name));
    const entry = ledger[name];
    if ((!entry || entry.bytes !== size) && rejected[name] !== size) pending.push(name);
  }
  return pending.sort((left, right) => stampOf(right).localeCompare(stampOf(left)));
}

export interface AdoptionResult {
  /** Entered in the ledger now. */
  adopted: string[];
  /** Looked at and found not whole: left where they are, not counted. */
  rejected: string[];
  /** Made with another key: not this install's to vouch for. */
  skipped: string[];
}

/**
 * Backups that are in the folder but not in the ledger (the ledger was lost, or could not be written the day the backup
 * was made) are not counted as copies, so pruning leaves them alone and the owner is told there is no good copy.
 * This opens them again, the newest first and no more than `max`, and enters the ones that pass. A file made with
 * another key is skipped from its header, without reading the rest.
 */
export async function adoptUnledgeredBackups(
  deps: Pick<BackupDeps, 'backupKey' | 'listDump' | 'paths' | 'now' | 'log'>,
  options: { max?: number } = {},
): Promise<AdoptionResult> {
  const result: AdoptionResult = { adopted: [], rejected: [], skipped: [] };
  const directory = deps.paths.backups;
  const pending = await unledgeredBackups(directory);
  const ownKeyId = keyIdOf(deps.backupKey());
  for (const name of pending.slice(0, options.max ?? 5)) {
    const path = join(directory, name);
    try {
      const { header } = await readArchiveHeader(path);
      if (header.keyId !== ownKeyId) {
        result.skipped.push(name);
        await rememberRejected(directory, name, await sizeOf(path)).catch(() => undefined);
        continue;
      }
      const verified = await verifyBackupFile(deps, path);
      await recordVerified(directory, name, {
        sha256: verified.sha256,
        bytes: verified.bytes,
        verifiedAt: deps.now().toISOString(),
      });
      result.adopted.push(name);
      deps.log?.(`a backup that was not in the ledger passed its check and was entered: ${name}`);
    } catch (error) {
      result.rejected.push(name);
      await rememberRejected(directory, name, await sizeOf(path).catch(() => -1)).catch(
        () => undefined,
      );
      deps.log?.(
        `a backup that is not in the ledger did not pass its check and was left alone: ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}

/** How many of each kind are kept. Safety copies are only a way back from one operation. */
const DEFAULT_KEEP: Record<BackupKind, number> = { daily: 14, manual: 14, safety: 3, upgrade: 3 };

/** Never fewer than this many verified daily or manual backups, whatever is asked. */
const MIN_VERIFIED = 7;

export interface PruneOptions {
  keep?: Partial<Record<BackupKind, number>>;
  minVerified?: number;
}

function stampOf(name: string): string {
  return /(\d{4}-\d{2}-\d{2}_\d{4})/.exec(name)?.[1] ?? name;
}

/**
 * Deletes the oldest backups of each kind beyond how many are kept, counting and deleting only the ones
 * that were verified (they are in the ledger and the file still has the size it had). The daily and the
 * manual backups are counted apart. A file nobody verified is neither counted nor touched.
 */
export async function pruneBackups(
  directory: string,
  options: PruneOptions = {},
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const ledger = await readLedger(directory);
  const deleted: string[] = [];
  for (const kind of Object.keys(KIND_NAMES) as BackupKind[]) {
    const pattern = new RegExp(
      `^consulvia-${KIND_NAMES[kind]}-\\d{4}-\\d{2}-\\d{2}_\\d{4}\\${BACKUP_EXTENSION}$`,
    );
    const verified: string[] = [];
    for (const name of names
      .filter((candidate) => pattern.test(candidate))
      .sort((left, right) => stampOf(left).localeCompare(stampOf(right)))) {
      const entry = ledger[name];
      if (entry && entry.bytes === (await sizeOf(join(directory, name)))) verified.push(name);
    }
    const floor = kind === 'daily' || kind === 'manual' ? (options.minVerified ?? MIN_VERIFIED) : 0;
    const retain = Math.max(options.keep?.[kind] ?? DEFAULT_KEEP[kind], floor);
    for (const name of verified.slice(0, Math.max(0, verified.length - retain))) {
      await rm(join(directory, name), { force: true });
      deleted.push(name);
    }
  }
  const gone = Object.keys(ledger).filter((name) => !names.includes(name));
  await forgetBackups(directory, [...deleted, ...gone]).catch(() => undefined);
  return deleted;
}

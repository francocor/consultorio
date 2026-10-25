import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { createArchiveWriter } from './backup-archive.js';
import {
  FORMAT,
  keyIdOf,
  type BackupHeader,
  type BackupKind,
  type KeyWrap,
} from './backup-crypto.js';
import { isBackupFile, listFiles, sizeOf } from './files.js';
import type { DataPaths } from './paths.js';

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
  backupKey: () => Buffer;
  keyWrap: () => KeyWrap;
  secrets: () => AdoptionPayload;
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

/**
 * A backup is one file: the dump of the database (`pg_dump -Fc`, streamed, never written plain to disk),
 * the whole `files` folder, the secrets another install needs to read it, and a manifest, all encrypted and
 * authenticated with the key of the install. It is written to a temporary name and renamed when complete.
 */
export async function createBackup(
  deps: BackupDeps,
  kind: BackupKind,
): Promise<{ path: string; bytes: number }> {
  const started = deps.now();
  const target = join(deps.paths.backups, backupFileName(kind, started));
  await mkdir(deps.paths.backups, { recursive: true });
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
        throw new BackupError(
          'The database dump failed',
          ended.stderr.trim().split(/\r?\n/).slice(-6).join('\n'),
        );
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
      const { bytes } = await writer.finish();
      deps.log?.(
        `backup written: ${target} (${String(bytes)} bytes, ${String(documents.length)} documents)`,
      );
      return { path: target, bytes };
    } catch (error) {
      await writer.abort();
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 3) throw error;
      deps.log?.('a document moved while the backup was being written; trying again');
    }
  }
}

/** The names a rotation looks at: the daily and manual backups, not the safety copies before a restore. */
const ROTATING = new RegExp(
  `^consulvia-(?:diaria|manual)-\\d{4}-\\d{2}-\\d{2}_\\d{4}\\${BACKUP_EXTENSION}$`,
);

function stampOf(name: string): string {
  return /(\d{4}-\d{2}-\d{2}_\d{4})/.exec(name)?.[1] ?? name;
}

/** Keeps the newest `keep` rotating backups and deletes the rest. Returns the names it deleted. */
export async function pruneBackups(directory: string, keep = 14): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const rotating = names
    .filter((name) => ROTATING.test(name))
    .sort((left, right) => stampOf(left).localeCompare(stampOf(right)));
  const doomed = rotating.slice(0, Math.max(0, rotating.length - keep));
  for (const name of doomed) await rm(join(directory, name), { force: true });
  return doomed;
}

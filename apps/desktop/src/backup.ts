import { createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { osEnvironment } from './api-env.js';
import type { DataPaths } from './paths.js';
import { sealRecovery, type RecoveryPayload } from './recovery.js';
import type { Runner } from './runner.js';
import { isBackupFile, listFiles, sizeOf, writeZip, type ZipSource } from './zip.js';

export const BACKUP_FORMAT = 1;

/** What `meta.json` says about a backup. */
export interface BackupMeta {
  format: number;
  createdAt: string;
  appVersion: string;
  /** How many migrations the database had: a newer backup cannot be restored by an older app. */
  migrationCount: number;
  database: string;
  /** A short fingerprint of the key of the clinical data, to know whether a backup belongs to this install. */
  kekFingerprint: string;
}

export function fingerprintOf(kmsLocalKekBase64: string): string {
  return createHash('sha256')
    .update(`consulvia-kek-fingerprint:${kmsLocalKekBase64}`)
    .digest('hex')
    .slice(0, 16);
}

export type BackupKind = 'manual' | 'daily' | 'safety';

export interface BackupDeps {
  paths: DataPaths;
  runner: Runner;
  /** `pg_dump.exe` */
  pgDump: string;
  /** The port the database listens on now. */
  databasePort: () => number;
  superuser: { user: string; password: string };
  database: string;
  recovery: () => { payload: RecoveryPayload; recoveryKey: string };
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

export function backupFileName(kind: BackupKind, date: Date): string {
  const base = kind === 'safety' ? 'consulvia-previa-restauracion' : 'consulvia';
  return `${base}-${stamp(date)}.zip`;
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
 * A backup is one zip with the database dump (`pg_dump -Fc`), the whole `files` folder, a `meta.json` and the
 * secrets the data cannot be read without, sealed with the recovery key. It is written to a temporary name
 * and renamed, so a half-written backup never looks like a good one.
 */
export async function createBackup(
  deps: BackupDeps,
  kind: BackupKind,
): Promise<{ path: string; bytes: number }> {
  const started = deps.now();
  const target = join(deps.paths.backups, backupFileName(kind, started));
  const scratch = join(
    deps.paths.root,
    `tmp-backup-${String(process.pid)}-${String(started.getTime())}`,
  );
  await mkdir(scratch, { recursive: true });
  try {
    const dump = join(scratch, 'db.dump');
    const result = await deps.runner(
      deps.pgDump,
      [
        '--format=custom',
        '--host=127.0.0.1',
        `--port=${String(deps.databasePort())}`,
        `--username=${deps.superuser.user}`,
        `--dbname=${deps.database}`,
        `--file=${dump}`,
        '--no-password',
      ],
      {
        env: { ...osEnvironment(), PGPASSWORD: deps.superuser.password },
        timeoutMs: 30 * 60_000,
      },
    );
    if (result.code !== 0) {
      throw new BackupError(
        'The database dump failed',
        result.stderr.trim().split(/\r?\n/).slice(-6).join('\n'),
      );
    }

    const { payload, recoveryKey } = deps.recovery();
    const meta: BackupMeta = {
      format: BACKUP_FORMAT,
      createdAt: started.toISOString(),
      appVersion: deps.appVersion,
      migrationCount: deps.migrationCount,
      database: deps.database,
      kekFingerprint: fingerprintOf(payload.kmsLocalKekBase64),
    };
    // The API moves a document between folders when its scan ends. If one moves between the listing and the
    // read, the listing is made again: a document must never be left out of a backup silently.
    let documents: { file: string; name: string }[] = [];
    for (let attempt = 1; ; attempt += 1) {
      documents = await listFiles(deps.paths.files, 'files/', isBackupFile);
      const sources: ZipSource[] = [
        { name: 'meta.json', content: `${JSON.stringify(meta, null, 2)}\n` },
        { name: 'recovery.json', content: sealRecovery(payload, recoveryKey) },
        { name: 'db.dump', file: dump, compress: false },
        ...documents.map((document) => ({ name: document.name, file: document.file })),
      ];
      try {
        await writeZip(target, sources);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || attempt >= 3) throw error;
        deps.log?.('a document moved while the backup was being written; trying again');
      }
    }
    const bytes = await sizeOf(target);
    deps.log?.(
      `backup written: ${target} (${String(bytes)} bytes, ${String(documents.length)} documents)`,
    );
    return { path: target, bytes };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The names a rotation looks at: the daily and manual backups, not the safety copies before a restore. */
const ROTATING = /^consulvia-\d{4}-\d{2}-\d{2}_\d{4}\.zip$/;

/** Keeps the newest `keep` rotating backups and deletes the rest. Returns the names it deleted. */
export async function pruneBackups(directory: string, keep = 14): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const rotating = names.filter((name) => ROTATING.test(name)).sort();
  const doomed = rotating.slice(0, Math.max(0, rotating.length - keep));
  for (const name of doomed) await rm(join(directory, name), { force: true });
  return doomed;
}

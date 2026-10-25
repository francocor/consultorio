import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { osEnvironment } from './api-env.js';
import { BACKUP_FORMAT, fingerprintOf, type BackupMeta } from './backup.js';
import type { DataPaths } from './paths.js';
import { openRecovery, RecoveryError, type RecoveryPayload } from './recovery.js';
import type { Runner } from './runner.js';
import { extractZip, listZipNames, readZipText } from './zip.js';

export type RestoreErrorCode =
  /** The file is not a Consulvia backup, or it is damaged. */
  | 'invalid_backup'
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

export interface BackupInfo {
  meta: BackupMeta;
  hasDump: boolean;
  hasRecovery: boolean;
}

/** Reads what a backup says about itself without unpacking it. */
export async function readBackupInfo(path: string): Promise<BackupInfo> {
  let names: string[];
  let metaText: string | null;
  try {
    names = await listZipNames(path);
    metaText = await readZipText(path, 'meta.json');
  } catch {
    throw new RestoreError('invalid_backup');
  }
  if (metaText === null) throw new RestoreError('invalid_backup');
  let meta: Partial<BackupMeta>;
  try {
    meta = JSON.parse(metaText) as Partial<BackupMeta>;
  } catch {
    throw new RestoreError('invalid_backup');
  }
  if (
    meta.format !== BACKUP_FORMAT ||
    typeof meta.migrationCount !== 'number' ||
    typeof meta.kekFingerprint !== 'string' ||
    typeof meta.createdAt !== 'string' ||
    typeof meta.appVersion !== 'string' ||
    typeof meta.database !== 'string'
  ) {
    throw new RestoreError('invalid_backup');
  }
  return {
    meta: meta as BackupMeta,
    hasDump: names.includes('db.dump'),
    hasRecovery: names.includes('recovery.json'),
  };
}

export interface RestoreDeps {
  paths: DataPaths;
  runner: Runner;
  /** `pg_restore.exe` */
  pgRestore: string;
  databasePort: () => number;
  superuser: { user: string; password: string };
  /**
   * The backup is restored into a database of its own, and that database replaces the real one only when the
   * restore has finished: a restore into the live database (`pg_restore --clean`) cannot drop the partitions
   * of a partitioned table, and one that stops half way leaves a broken database.
   */
  scratch: {
    name: string;
    create: () => Promise<void>;
    swapIn: () => Promise<void>;
    drop: () => Promise<void>;
  };
  migrationCount: number;
  /** The key of the clinical data of THIS install. */
  currentKek: () => string;
  /** Stops the API and the worker. The database stays up. */
  stopServices: () => Promise<void>;
  /** Applies the migrations and starts the API and the worker again, with the secrets of the install as they are now. */
  startServices: () => Promise<void>;
  /** Makes the secrets of the backup the secrets of this install. Called after the data is in place. */
  adoptSecrets: (payload: RecoveryPayload) => Promise<void> | void;
  now: () => Date;
  log?: (message: string) => void;
}

export interface RestoreOptions {
  /** Needed only when the backup belongs to another installation. */
  recoveryKey?: string;
}

/**
 * Puts a backup in place of the data of this install. The caller has made a safety backup and asked the
 * owner to confirm. The order keeps the old data recoverable for as long as possible: the backup is
 * unpacked and checked first, the database is restored in one transaction (a failure changes nothing),
 * and the old `files` folder is moved aside, not deleted, until the new one is in place.
 */
export async function restoreBackup(
  deps: RestoreDeps,
  archive: string,
  options: RestoreOptions = {},
): Promise<{ meta: BackupMeta }> {
  const info = await readBackupInfo(archive);
  if (!info.hasDump) throw new RestoreError('invalid_backup');
  if (info.meta.migrationCount > deps.migrationCount) throw new RestoreError('newer_version');

  // Whose backup is it? Its key is the same as ours, or the owner must give the recovery key.
  let adopted: RecoveryPayload | null = null;
  if (info.meta.kekFingerprint !== fingerprintOf(deps.currentKek())) {
    if (options.recoveryKey === undefined || options.recoveryKey.trim() === '') {
      throw new RestoreError('recovery_key_required');
    }
    const sealed = await readZipText(archive, 'recovery.json');
    if (sealed === null) throw new RestoreError('invalid_backup');
    try {
      adopted = openRecovery(sealed, options.recoveryKey);
    } catch (error) {
      if (error instanceof RecoveryError && error.code === 'wrong_key') {
        throw new RestoreError('wrong_recovery_key');
      }
      throw new RestoreError('invalid_backup');
    }
    if (fingerprintOf(adopted.kmsLocalKekBase64) !== info.meta.kekFingerprint) {
      throw new RestoreError('invalid_backup');
    }
  }

  const stamp = String(deps.now().getTime());
  const unpacked = join(deps.paths.root, `tmp-restore-${stamp}`);
  const aside = `${deps.paths.files}.replaced-${stamp}`;
  await mkdir(unpacked, { recursive: true });
  const moved = { files: false };
  let servicesStopped = false;
  let scratchCreated = false;
  try {
    await extractZip(archive, unpacked, (name) => name === 'db.dump' || name.startsWith('files/'));

    await deps.stopServices();
    servicesStopped = true;

    await deps.scratch.create();
    scratchCreated = true;
    const restored = await deps.runner(
      deps.pgRestore,
      [
        '--host=127.0.0.1',
        `--port=${String(deps.databasePort())}`,
        `--username=${deps.superuser.user}`,
        `--dbname=${deps.scratch.name}`,
        '--single-transaction',
        '--exit-on-error',
        '--no-password',
        join(unpacked, 'db.dump'),
      ],
      {
        env: { ...osEnvironment(), PGPASSWORD: deps.superuser.password },
        timeoutMs: 30 * 60_000,
      },
    );
    if (restored.code !== 0) {
      throw new RestoreError(
        'restore_failed',
        restored.stderr.trim().split(/\r?\n/).slice(-8).join('\n'),
      );
    }

    // The documents: the old folder is moved aside, the unpacked one takes its place.
    try {
      await rename(deps.paths.files, aside);
      moved.files = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(join(unpacked, 'files'), { recursive: true });
    await rename(join(unpacked, 'files'), deps.paths.files);

    // The database goes last: until here nothing of the live data was touched, and the documents can be put back.
    await deps.scratch.swapIn();
    scratchCreated = false;

    if (adopted) await deps.adoptSecrets(adopted);
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
  return { meta: info.meta };
}

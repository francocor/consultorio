import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  keyIdOf,
  newBackupKey,
  wrapBackupKey,
  hashRecoveryKey,
  type KeyWrap,
} from './backup-crypto.js';
import type { AdoptionPayload, BackupDeps, DumpProcess } from './backup.js';
import type { DataPaths } from './paths.js';
import { generateRecoveryKey } from './recovery-key.js';

/** What the tests of backups and restores share: an install's keys, its folders and a pretend `pg_dump`. */

export interface TestInstall {
  backupKey: Buffer;
  recoveryKey: string;
  wrap: KeyWrap;
  secrets: AdoptionPayload;
  keyId: string;
}

export function newTestInstall(): TestInstall {
  const backupKey = newBackupKey();
  const recoveryKey = generateRecoveryKey();
  return {
    backupKey,
    recoveryKey,
    wrap: wrapBackupKey(backupKey, recoveryKey),
    keyId: keyIdOf(backupKey),
    secrets: {
      slug: 'consultorio',
      kmsLocalKekBase64: newBackupKey().toString('base64'),
      addressHashPepper: newBackupKey().toString('base64url'),
      storageUploadSecret: newBackupKey().toString('base64url'),
      recoveryKeyHash: hashRecoveryKey(recoveryKey),
    },
  };
}

export function testPaths(folder: string): DataPaths {
  return {
    root: join(folder, 'Consulvia'),
    pgdata: join(folder, 'Consulvia', 'pgdata'),
    files: join(folder, 'Consulvia', 'files'),
    outbox: join(folder, 'Consulvia', 'outbox'),
    logs: join(folder, 'Consulvia', 'logs'),
    configFile: join(folder, 'Consulvia', 'config.json'),
    electronProfile: join(folder, 'Consulvia', 'electron-profile'),
    backups: join(folder, 'Documents', 'Consulvia', 'Copias'),
  };
}

/** A `pg_dump` that writes `content` and ends with `code`. */
export function fakeDump(content: string | Buffer, code = 0, stderr = ''): () => DumpProcess {
  return () => {
    const stdout = new PassThrough();
    stdout.end(content);
    return { stdout, finished: Promise.resolve({ code, stderr }) };
  };
}

export function testBackupDeps(
  install: TestInstall,
  paths: DataPaths,
  overrides: Partial<BackupDeps> = {},
): BackupDeps {
  return {
    paths,
    startDump: fakeDump('PGDMP-fake-dump-content'),
    backupKey: () => install.backupKey,
    keyWrap: () => install.wrap,
    secrets: () => install.secrets,
    appVersion: '0.1.0',
    migrationCount: 77,
    now: () => new Date(2026, 9, 24, 15, 30, 45),
    ...overrides,
  };
}

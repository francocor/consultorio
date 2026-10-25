import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBackup, type BackupDeps } from './backup.js';
import type { DataPaths } from './paths.js';
import type { RecoveryPayload } from './recovery.js';
import { readBackupInfo, restoreBackup, RestoreError, type RestoreDeps } from './restore.js';
import type { RunOptions, RunResult, Runner } from './runner.js';
import { generateSecrets } from './secrets.js';
import { writeZip } from './zip.js';

let folder: string;
let paths: DataPaths;
let events: string[];
let restoreCall: { args: string[]; options: RunOptions | undefined } | null;
let restoreResult: Partial<RunResult>;
let adopted: RecoveryPayload | null;
let failAdopt: boolean;

const mine = generateSecrets();
const theirs = generateSecrets();
const payloadOf = (secrets: typeof mine): RecoveryPayload => ({
  slug: 'consultorio',
  kmsLocalKekBase64: secrets.kmsLocalKekBase64,
  addressHashPepper: secrets.addressHashPepper,
  storageUploadSecret: secrets.storageUploadSecret,
});

const runner: Runner = (file, args, options) => {
  if (file.includes('pg_dump')) {
    const target = args.find((argument) => argument.startsWith('--file='))?.slice('--file='.length);
    if (target) writeFileSync(target, 'PGDMP-fake');
    return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
  }
  events.push('pg_restore');
  restoreCall = { args, options };
  return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...restoreResult });
};

function backupDeps(secrets: typeof mine, migrationCount = 77): BackupDeps {
  return {
    paths,
    runner,
    pgDump: 'pg_dump.exe',
    databasePort: () => 54321,
    superuser: { user: 'postgres', password: 'x'.repeat(32) },
    database: 'consultorio',
    recovery: () => ({ payload: payloadOf(secrets), recoveryKey: secrets.recoveryKey }),
    appVersion: '0.1.0',
    migrationCount,
    now: () => new Date(2026, 9, 24, 15, 30, 45),
  };
}

function restoreDeps(secrets: typeof mine = mine, migrationCount = 77): RestoreDeps {
  return {
    paths,
    runner,
    pgRestore: 'C:\\tools\\pg_restore.exe',
    databasePort: () => 54321,
    superuser: { user: 'postgres', password: 'super-secret-password-0123456789' },
    database: 'consultorio',
    migrationCount,
    currentKek: () => secrets.kmsLocalKekBase64,
    stopServices: () => {
      events.push('stop');
      return Promise.resolve();
    },
    startServices: () => {
      events.push('start');
      return Promise.resolve();
    },
    adoptSecrets: (payload) => {
      if (failAdopt) throw new Error('could not write config.json');
      adopted = payload;
      events.push('adopt');
    },
    now: () => new Date(2026, 9, 25, 8, 0, 0),
  };
}

/** A backup of `source` made with `secrets`, whose documents are `documents`. */
async function makeBackup(
  secrets: typeof mine,
  documents: Record<string, string>,
  migrationCount = 77,
) {
  rmSync(paths.files, { recursive: true, force: true });
  for (const [name, content] of Object.entries(documents)) {
    mkdirSync(join(paths.files, ...name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(paths.files, ...name.split('/')), content);
  }
  const { path } = await createBackup(backupDeps(secrets, migrationCount), 'manual');
  return path;
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-restore-'));
  paths = {
    root: join(folder, 'Consulvia'),
    pgdata: join(folder, 'Consulvia', 'pgdata'),
    files: join(folder, 'Consulvia', 'files'),
    outbox: join(folder, 'Consulvia', 'outbox'),
    logs: join(folder, 'Consulvia', 'logs'),
    configFile: join(folder, 'Consulvia', 'config.json'),
    electronProfile: join(folder, 'Consulvia', 'electron-profile'),
    backups: join(folder, 'Documents', 'Consulvia', 'Copias'),
  };
  mkdirSync(paths.root, { recursive: true });
  events = [];
  restoreCall = null;
  restoreResult = {};
  adopted = null;
  failAdopt = false;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const readDoc = (name: string) => readFileSync(join(paths.files, ...name.split('/')), 'utf8');

describe('reading a backup', () => {
  it('tells what it is without unpacking it', async () => {
    const path = await makeBackup(mine, { 't/a/docs/1.obj': 'one' });

    const info = await readBackupInfo(path);

    expect(info).toMatchObject({
      hasDump: true,
      hasRecovery: true,
      meta: { format: 1, migrationCount: 77 },
    });
  });

  it('refuses a file that is not a backup of Consulvia', async () => {
    const notZip = join(folder, 'notes.zip');
    writeFileSync(notZip, 'this is not a zip');
    const noMeta = join(folder, 'other.zip');
    await writeZip(noMeta, [{ name: 'readme.txt', content: 'hello' }]);
    const badMeta = join(folder, 'bad.zip');
    await writeZip(badMeta, [{ name: 'meta.json', content: '{"format":99}' }]);

    for (const file of [notZip, noMeta, badMeta, join(folder, 'missing.zip')]) {
      await expect(readBackupInfo(file), file).rejects.toMatchObject({ code: 'invalid_backup' });
    }
  });
});

describe('restoring a backup of this installation', () => {
  it('stops the services, restores the database in one transaction, replaces the documents and starts again', async () => {
    const path = await makeBackup(mine, { 't/a/docs/1.obj': 'from the backup' });
    rmSync(paths.files, { recursive: true, force: true });
    mkdirSync(join(paths.files, 't', 'a', 'docs'), { recursive: true });
    writeFileSync(join(paths.files, 't', 'a', 'docs', 'newer.obj'), 'made after the backup');

    await restoreBackup(restoreDeps(), path);

    expect(events).toEqual(['stop', 'pg_restore', 'start']);
    expect(restoreCall?.args).toEqual(
      expect.arrayContaining([
        '--host=127.0.0.1',
        '--port=54321',
        '--username=postgres',
        '--dbname=consultorio',
        '--clean',
        '--if-exists',
        '--single-transaction',
        '--exit-on-error',
        '--no-password',
      ]),
    );
    expect(restoreCall?.args.at(-1)).toMatch(/db\.dump$/);
    expect(restoreCall?.options?.env?.['PGPASSWORD']).toBe('super-secret-password-0123456789');
    expect(readDoc('t/a/docs/1.obj')).toBe('from the backup');
    expect(existsSync(join(paths.files, 't', 'a', 'docs', 'newer.obj'))).toBe(false);
    expect(adopted).toBeNull();
  });

  it('leaves no scratch folder and no old documents folder behind', async () => {
    const path = await makeBackup(mine, { 't/a/docs/1.obj': 'one' });

    await restoreBackup(restoreDeps(), path);

    expect(readdirSync(paths.root).filter((name) => /^tmp-restore|replaced/.test(name))).toEqual(
      [],
    );
  });

  it('changes nothing when the database restore fails, and starts the services again', async () => {
    const path = await makeBackup(mine, { 't/a/docs/1.obj': 'from the backup' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'current data');
    restoreResult = { code: 1, stderr: 'pg_restore: error: could not execute query\n' };

    const failure = await restoreBackup(restoreDeps(), path).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RestoreError);
    expect(failure).toMatchObject({ code: 'restore_failed' });
    expect((failure as RestoreError).detail).toContain('could not execute query');
    expect(readDoc('t/a/docs/1.obj')).toBe('current data');
    expect(events).toEqual(['stop', 'pg_restore', 'start']);
  });

  it('puts the old documents back when something fails after they were moved', async () => {
    const path = await makeBackup(theirs, { 't/a/docs/1.obj': 'from the backup' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'current data');
    failAdopt = true;

    await expect(
      restoreBackup(restoreDeps(), path, { recoveryKey: theirs.recoveryKey }),
    ).rejects.toThrow('could not write config.json');

    expect(readDoc('t/a/docs/1.obj')).toBe('current data');
    expect(events.at(-1)).toBe('start');
  });

  it('refuses a backup made by a newer version, before it touches anything', async () => {
    const path = await makeBackup(mine, { 't/a/docs/1.obj': 'one' }, 80);

    await expect(restoreBackup(restoreDeps(mine, 77), path)).rejects.toMatchObject({
      code: 'newer_version',
    });
    expect(events).toEqual([]);
  });

  it('accepts a backup made by an older version', async () => {
    const path = await makeBackup(mine, { 't/a/docs/1.obj': 'one' }, 60);

    await restoreBackup(restoreDeps(mine, 77), path);

    expect(events).toEqual(['stop', 'pg_restore', 'start']);
  });
});

describe('restoring a backup of another installation', () => {
  it('asks for the recovery key before it touches anything', async () => {
    const path = await makeBackup(theirs, { 't/a/docs/1.obj': 'one' });

    await expect(restoreBackup(restoreDeps(), path)).rejects.toMatchObject({
      code: 'recovery_key_required',
    });
    await expect(restoreBackup(restoreDeps(), path, { recoveryKey: '  ' })).rejects.toMatchObject({
      code: 'recovery_key_required',
    });
    expect(events).toEqual([]);
  });

  it('refuses a wrong key without stopping anything', async () => {
    const path = await makeBackup(theirs, { 't/a/docs/1.obj': 'one' });

    await expect(
      restoreBackup(restoreDeps(), path, { recoveryKey: mine.recoveryKey }),
    ).rejects.toMatchObject({ code: 'wrong_recovery_key' });
    expect(events).toEqual([]);
  });

  it('adopts the secrets of the backup once the data is in place, so the data can be read', async () => {
    const path = await makeBackup(theirs, { 't/a/docs/1.obj': 'theirs' });

    await restoreBackup(restoreDeps(), path, { recoveryKey: theirs.recoveryKey.toLowerCase() });

    expect(events).toEqual(['stop', 'pg_restore', 'adopt', 'start']);
    expect(adopted).toEqual(payloadOf(theirs));
    expect(readDoc('t/a/docs/1.obj')).toBe('theirs');
  });

  it('does not adopt anything when the database restore fails', async () => {
    const path = await makeBackup(theirs, { 't/a/docs/1.obj': 'theirs' });
    restoreResult = { code: 1, stderr: 'boom' };

    await expect(
      restoreBackup(restoreDeps(), path, { recoveryKey: theirs.recoveryKey }),
    ).rejects.toMatchObject({ code: 'restore_failed' });

    expect(adopted).toBeNull();
  });
});

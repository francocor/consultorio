import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  backupFileName,
  BACKUP_FORMAT,
  BackupError,
  createBackup,
  fingerprintOf,
  localDay,
  pruneBackups,
  stamp,
  type BackupDeps,
  type BackupMeta,
} from './backup.js';
import type { DataPaths } from './paths.js';
import { openRecovery } from './recovery.js';
import type { RunOptions, RunResult, Runner } from './runner.js';
import { generateSecrets } from './secrets.js';
import { listZipNames, readZipText } from './zip.js';

let folder: string;
let paths: DataPaths;
let dumpCalls: { file: string; args: string[]; options: RunOptions | undefined }[];
let dumpResult: Partial<RunResult>;

const secrets = generateSecrets();
const payload = {
  slug: 'consultorio',
  kmsLocalKekBase64: secrets.kmsLocalKekBase64,
  addressHashPepper: secrets.addressHashPepper,
  storageUploadSecret: secrets.storageUploadSecret,
};

/** Stands in for pg_dump: writes the file it is asked to write. */
const runner: Runner = (file, args, options) => {
  dumpCalls.push({ file, args, options });
  const target = args.find((argument) => argument.startsWith('--file='))?.slice('--file='.length);
  if (target && (dumpResult.code ?? 0) === 0) writeFileSync(target, 'PGDMP-fake-dump-content');
  return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, ...dumpResult });
};

function deps(now = new Date(2026, 9, 24, 15, 30, 45)): BackupDeps {
  return {
    paths,
    runner,
    pgDump: 'C:\\tools\\pg_dump.exe',
    databasePort: () => 54321,
    superuser: { user: 'postgres', password: 'super-secret-password-0123456789' },
    database: 'consultorio',
    recovery: () => ({ payload, recoveryKey: secrets.recoveryKey }),
    appVersion: '0.1.0',
    migrationCount: 77,
    now: () => now,
  };
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-backup-'));
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
  mkdirSync(join(paths.files, 't', 'abc', 'docs'), { recursive: true });
  mkdirSync(join(paths.files, 't', 'abc', 'quarantine'), { recursive: true });
  writeFileSync(join(paths.files, 't', 'abc', 'docs', 'o1.obj'), 'document one');
  writeFileSync(
    join(paths.files, 't', 'abc', 'docs', 'o1.meta'),
    '{"contentType":"application/pdf"}',
  );
  writeFileSync(join(paths.files, 't', 'abc', 'quarantine', 'o2.obj'), 'document two');
  writeFileSync(join(paths.files, 't', 'abc', 'docs', 'o3.obj.tmp'), 'half written');
  writeFileSync(join(paths.files, 't', 'abc', 'docs', 'o4.obj.moving'), 'half moved');
  dumpCalls = [];
  dumpResult = {};
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

describe('the name of a backup', () => {
  it('has the local date and time and sorts by time', () => {
    const date = new Date(2026, 0, 5, 9, 7);

    expect(stamp(date)).toBe('2026-01-05_0907');
    expect(localDay(date)).toBe('2026-01-05');
    expect(backupFileName('manual', date)).toBe('consulvia-2026-01-05_0907.zip');
    expect(backupFileName('daily', date)).toBe('consulvia-2026-01-05_0907.zip');
    expect(backupFileName('safety', date)).toBe(
      'consulvia-previa-restauracion-2026-01-05_0907.zip',
    );
    expect(
      backupFileName('manual', new Date(2026, 0, 5, 9, 8)) > backupFileName('manual', date),
    ).toBe(true);
  });
});

describe('making a backup', () => {
  it('writes one zip in the backups folder with the dump, the documents, the meta and the sealed secrets', async () => {
    const result = await createBackup(deps(), 'manual');

    expect(result.path).toBe(join(paths.backups, 'consulvia-2026-10-24_1530.zip'));
    expect(result.bytes).toBeGreaterThan(0);
    const names = (await listZipNames(result.path)).sort();
    expect(names).toEqual([
      'db.dump',
      'files/t/abc/docs/o1.meta',
      'files/t/abc/docs/o1.obj',
      'files/t/abc/quarantine/o2.obj',
      'meta.json',
      'recovery.json',
    ]);
  });

  it('leaves out the leftovers of an interrupted write', async () => {
    const { path } = await createBackup(deps(), 'manual');

    const names = await listZipNames(path);

    expect(names.some((name) => name.endsWith('.tmp') || name.endsWith('.moving'))).toBe(false);
  });

  it('dumps the database in the custom format, as the superuser, with the password only in the environment', async () => {
    await createBackup(deps(), 'manual');

    const [call] = dumpCalls;
    expect(call?.file).toBe('C:\\tools\\pg_dump.exe');
    expect(call?.args).toEqual(
      expect.arrayContaining([
        '--format=custom',
        '--host=127.0.0.1',
        '--port=54321',
        '--username=postgres',
        '--dbname=consultorio',
        '--no-password',
      ]),
    );
    expect(call?.args.join(' ')).not.toContain('super-secret-password');
    expect(call?.options?.env?.['PGPASSWORD']).toBe('super-secret-password-0123456789');
  });

  it('says in meta.json what it is, and how to tell whose key it needs', async () => {
    const { path } = await createBackup(deps(), 'manual');

    const meta = JSON.parse((await readZipText(path, 'meta.json')) ?? '') as BackupMeta;

    expect(meta).toEqual({
      format: BACKUP_FORMAT,
      createdAt: new Date(2026, 9, 24, 15, 30, 45).toISOString(),
      appVersion: '0.1.0',
      migrationCount: 77,
      database: 'consultorio',
      kekFingerprint: fingerprintOf(secrets.kmsLocalKekBase64),
    });
    expect(JSON.stringify(meta)).not.toContain(secrets.kmsLocalKekBase64);
  });

  it('seals the secrets the data cannot be read without, and only the recovery key opens them', async () => {
    const { path } = await createBackup(deps(), 'manual');
    const sealed = (await readZipText(path, 'recovery.json')) ?? '';

    expect(sealed).not.toContain(secrets.kmsLocalKekBase64);
    expect(openRecovery(sealed, secrets.recoveryKey)).toEqual(payload);
    expect(() => openRecovery(sealed, generateSecrets().recoveryKey)).toThrow();
  });

  it('leaves no partial file and no scratch folder, and reports a dump that failed', async () => {
    dumpResult = { code: 1, stderr: 'pg_dump: error: connection refused\n' };

    const failure = await createBackup(deps(), 'manual').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackupError);
    expect((failure as BackupError).detail).toContain('connection refused');
    expect(existsSync(paths.backups) ? readdirSync(paths.backups) : []).toEqual([]);
    expect(readdirSync(paths.root).filter((name) => name.startsWith('tmp-backup'))).toEqual([]);
  });

  it('works when there are no documents yet', async () => {
    rmSync(paths.files, { recursive: true, force: true });

    const { path } = await createBackup(deps(), 'daily');

    expect((await listZipNames(path)).sort()).toEqual(['db.dump', 'meta.json', 'recovery.json']);
  });
});

describe('keeping the last 14 backups', () => {
  it('deletes the oldest of the rotating backups and keeps the newest', async () => {
    mkdirSync(paths.backups, { recursive: true });
    const names = Array.from(
      { length: 17 },
      (_, index) => `consulvia-2026-10-${String(index + 1).padStart(2, '0')}_0900.zip`,
    );
    for (const name of names) writeFileSync(join(paths.backups, name), 'x');

    const deleted = await pruneBackups(paths.backups, 14);

    expect(deleted).toEqual(names.slice(0, 3));
    expect(readdirSync(paths.backups).sort()).toEqual(names.slice(3));
  });

  it('never touches the safety backups before a restore, or files that are not backups', async () => {
    mkdirSync(paths.backups, { recursive: true });
    const keep = [
      'consulvia-previa-restauracion-2020-01-01_0900.zip',
      'notas.txt',
      'consulvia-2020-01-01.zip',
      'consulvia-2020-01-01_0900.zip.partial',
    ];
    for (const name of keep) writeFileSync(join(paths.backups, name), 'x');
    for (let day = 1; day <= 15; day += 1) {
      writeFileSync(
        join(paths.backups, `consulvia-2026-10-${String(day).padStart(2, '0')}_0900.zip`),
        'x',
      );
    }

    await pruneBackups(paths.backups, 14);

    const left = readdirSync(paths.backups);
    for (const name of keep) expect(left).toContain(name);
    expect(left.filter((name) => /^consulvia-2026/.test(name))).toHaveLength(14);
  });

  it('does nothing when the folder does not exist', async () => {
    expect(await pruneBackups(join(folder, 'nowhere'))).toEqual([]);
  });
});

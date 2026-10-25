import { createHash } from 'node:crypto';
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

import { readArchive, readArchiveHeader } from './backup-archive.js';
import { unwrapBackupKey } from './backup-crypto.js';
import {
  fakeDump,
  newTestInstall,
  testBackupDeps,
  testPaths,
  type TestInstall,
} from './backup-testing.js';
import {
  backupFileName,
  BackupError,
  createBackup,
  localDay,
  pruneBackups,
  stamp,
  type Manifest,
} from './backup.js';
import type { DataPaths } from './paths.js';

let folder: string;
let paths: DataPaths;
let install: TestInstall;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-backup-'));
  paths = testPaths(folder);
  install = newTestInstall();
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
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

async function entriesOf(file: string) {
  const entries = new Map<string, Buffer>();
  await readArchive(file, install.backupKey, async (entry) => {
    const parts: Buffer[] = [];
    for await (const part of entry.data) parts.push(part);
    entries.set(entry.name, Buffer.concat(parts));
  });
  return entries;
}

describe('the name of a backup', () => {
  it('has the kind, the local date and time, and sorts by time', () => {
    const date = new Date(2026, 0, 5, 9, 7);

    expect(stamp(date)).toBe('2026-01-05_0907');
    expect(localDay(date)).toBe('2026-01-05');
    expect(backupFileName('daily', date)).toBe('consulvia-diaria-2026-01-05_0907.cvb');
    expect(backupFileName('manual', date)).toBe('consulvia-manual-2026-01-05_0907.cvb');
    expect(backupFileName('safety', date)).toBe(
      'consulvia-previa-restauracion-2026-01-05_0907.cvb',
    );
    expect(backupFileName('upgrade', date)).toBe(
      'consulvia-previa-actualizacion-2026-01-05_0907.cvb',
    );
    expect(
      backupFileName('manual', new Date(2026, 0, 5, 9, 8)) > backupFileName('manual', date),
    ).toBe(true);
  });
});

describe('making a backup', () => {
  it('writes one encrypted file with the dump, the documents, the secrets and a manifest', async () => {
    const result = await createBackup(testBackupDeps(install, paths), 'manual');

    expect(result.path).toBe(join(paths.backups, 'consulvia-manual-2026-10-24_1530.cvb'));
    expect(result.bytes).toBeGreaterThan(0);
    const entries = await entriesOf(result.path);
    expect([...entries.keys()].sort()).toEqual([
      'db.dump',
      'files/t/abc/docs/o1.meta',
      'files/t/abc/docs/o1.obj',
      'files/t/abc/quarantine/o2.obj',
      'manifest.json',
      'secrets.json',
    ]);
    expect(entries.get('db.dump')?.toString()).toBe('PGDMP-fake-dump-content');
    expect(entries.get('files/t/abc/docs/o1.obj')?.toString()).toBe('document one');
    expect(JSON.parse(entries.get('secrets.json')?.toString() ?? '')).toEqual(install.secrets);
  });

  it('says in the manifest what must be true of the rest', async () => {
    const { path } = await createBackup(testBackupDeps(install, paths), 'manual');

    const manifest = JSON.parse(
      (await entriesOf(path)).get('manifest.json')?.toString() ?? '',
    ) as Manifest;

    expect(manifest).toEqual({
      dumpBytes: 'PGDMP-fake-dump-content'.length,
      dumpSha256: createHash('sha256').update('PGDMP-fake-dump-content').digest('hex'),
      fileCount: 3,
      fileBytes:
        'document one'.length + '{"contentType":"application/pdf"}'.length + 'document two'.length,
    });
  });

  it('leaves out the leftovers of an interrupted write', async () => {
    const { path } = await createBackup(testBackupDeps(install, paths), 'manual');

    const names = [...(await entriesOf(path)).keys()];

    expect(names.some((name) => name.endsWith('.tmp') || name.endsWith('.moving'))).toBe(false);
  });

  it('does not show a word of what is inside', async () => {
    writeFileSync(
      join(paths.files, 't', 'abc', 'docs', 'o1.obj'),
      'Diagnóstico: hipertensión de María Pérez',
    );
    const { path } = await createBackup(
      testBackupDeps(install, paths, {
        startDump: fakeDump('COPY patient (name) FROM stdin; María Pérez'),
      }),
      'manual',
    );

    const bytes = readFileSync(path);

    for (const secret of ['hipertensión', 'María Pérez', 'COPY patient', 'o1.obj', 'consultorio']) {
      expect(bytes.includes(Buffer.from(secret)), secret).toBe(false);
    }
    expect(bytes.includes(install.backupKey)).toBe(false);
  });

  it('puts in the header what is needed to open it elsewhere: the key wrapped by the recovery key', async () => {
    const { path } = await createBackup(testBackupDeps(install, paths), 'daily');

    const { header } = await readArchiveHeader(path);

    expect(header).toMatchObject({
      format: 2,
      kind: 'daily',
      appVersion: '0.1.0',
      migrationCount: 77,
      keyId: install.keyId,
      createdAt: new Date(2026, 9, 24, 15, 30, 45).toISOString(),
    });
    expect(unwrapBackupKey(header.wrap, install.recoveryKey).equals(install.backupKey)).toBe(true);
  });

  it('leaves no partial file and reports a dump that failed, with what pg_dump said', async () => {
    const failure = await createBackup(
      testBackupDeps(install, paths, {
        startDump: fakeDump('PGDMP', 1, 'pg_dump: error: connection refused\n'),
      }),
      'manual',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackupError);
    expect((failure as BackupError).detail).toContain('connection refused');
    expect(readdirSync(paths.backups)).toEqual([]);
  });

  it('refuses a dump that is empty even if pg_dump says it worked', async () => {
    await expect(
      createBackup(testBackupDeps(install, paths, { startDump: fakeDump('') }), 'manual'),
    ).rejects.toBeInstanceOf(BackupError);
    expect(readdirSync(paths.backups)).toEqual([]);
  });

  it('works when there are no documents yet', async () => {
    rmSync(paths.files, { recursive: true, force: true });

    const { path } = await createBackup(testBackupDeps(install, paths), 'daily');

    expect([...(await entriesOf(path)).keys()].sort()).toEqual([
      'db.dump',
      'manifest.json',
      'secrets.json',
    ]);
  });

  it('two backups of the same data are different files', async () => {
    const first = await createBackup(testBackupDeps(install, paths), 'manual');
    const second = await createBackup(
      testBackupDeps(install, paths, { now: () => new Date(2026, 9, 24, 15, 31, 0) }),
      'manual',
    );

    expect(readFileSync(first.path).equals(readFileSync(second.path))).toBe(false);
  });
});

describe('keeping the last 14 backups', () => {
  const names = (kind: string, days: number[]) =>
    days.map((day) => `consulvia-${kind}-2026-10-${String(day).padStart(2, '0')}_0900.cvb`);

  it('deletes the oldest of the rotating backups and keeps the newest', async () => {
    mkdirSync(paths.backups, { recursive: true });
    const all = names(
      'diaria',
      Array.from({ length: 17 }, (_, index) => index + 1),
    );
    for (const name of all) writeFileSync(join(paths.backups, name), 'x');

    const deleted = await pruneBackups(paths.backups, 14);

    expect(deleted).toEqual(all.slice(0, 3));
    expect(readdirSync(paths.backups).sort()).toEqual(all.slice(3));
  });

  it('never touches the safety backups, or files that are not backups', async () => {
    mkdirSync(paths.backups, { recursive: true });
    const keep = [
      'consulvia-previa-restauracion-2020-01-01_0900.cvb',
      'consulvia-previa-actualizacion-2020-01-01_0900.cvb',
      'notas.txt',
      'consulvia-diaria-2020-01-01_0900.cvb.partial',
      'consulvia-2020-01-01_0900.zip',
    ];
    for (const name of keep) writeFileSync(join(paths.backups, name), 'x');
    for (const name of names(
      'diaria',
      Array.from({ length: 15 }, (_, index) => index + 1),
    )) {
      writeFileSync(join(paths.backups, name), 'x');
    }

    await pruneBackups(paths.backups, 14);

    const left = readdirSync(paths.backups);
    for (const name of keep) expect(left).toContain(name);
    expect(left.filter((name) => /^consulvia-diaria-2026/.test(name))).toHaveLength(14);
  });

  it('does nothing when the folder does not exist', async () => {
    expect(await pruneBackups(join(folder, 'nowhere'))).toEqual([]);
    expect(existsSync(join(folder, 'nowhere'))).toBe(false);
  });
});

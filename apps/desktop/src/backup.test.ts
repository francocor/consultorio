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
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readArchive, readArchiveHeader } from './backup-archive.js';
import { unwrapBackupKey } from './backup-crypto.js';
import { readLedger, recordVerified, sha256OfFile } from './backup-ledger.js';
import {
  fakeDump,
  fakeList,
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
  verifyBackupFile,
  type Manifest,
} from './backup.js';
import { DiskFullError } from './disk.js';
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

describe('a backup is opened again after it is written', () => {
  it('records the file in the ledger with its hash once it has authenticated and its dump has been listed', async () => {
    const { path } = await createBackup(testBackupDeps(install, paths), 'daily');

    const ledger = await readLedger(paths.backups);

    const entry = ledger['consulvia-diaria-2026-10-24_1530.cvb'];
    expect(entry?.sha256).toBe(await sha256OfFile(path));
    expect(entry?.bytes).toBe(readFileSync(path).length);
  });

  it('gives the dump to pg_restore --list, and the backup does not stand if it cannot read it', async () => {
    const failure = await createBackup(
      testBackupDeps(install, paths, {
        listDump: fakeList(1, 'pg_restore: error: unsupported version'),
      }),
      'manual',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BackupError);
    expect((failure as BackupError).detail).toContain('unsupported version');
    // Neither the file nor an entry for it is left: it must not be taken for a good copy.
    expect(readdirSync(paths.backups).filter((name) => name.endsWith('.cvb'))).toEqual([]);
    expect(await readLedger(paths.backups)).toEqual({});
  });

  it('keeps a backup that passed its check even when the ledger cannot be written (an antivirus holds the file)', async () => {
    // A folder where the ledger should be: renaming over it fails, however many times it is tried.
    mkdirSync(join(paths.backups, 'registro-de-copias.json'), { recursive: true });
    const messages: string[] = [];

    const { path } = await createBackup(
      testBackupDeps(install, paths, { log: (message) => messages.push(message) }),
      'manual',
    );

    expect(existsSync(path)).toBe(true);
    expect(messages.some((message) => message.includes('ledger'))).toBe(true);
  });

  it('refuses a file that does not authenticate', async () => {
    const { path } = await createBackup(testBackupDeps(install, paths), 'manual');
    const bytes = readFileSync(path);
    bytes[bytes.length - 40] = (bytes[bytes.length - 40] ?? 0) ^ 0xff;
    writeFileSync(path, bytes);

    await expect(verifyBackupFile(testBackupDeps(install, paths), path)).rejects.toBeInstanceOf(
      BackupError,
    );
  });
});

describe('the room on the disk', () => {
  it('refuses before it writes a byte when the disk cannot hold twice the data', async () => {
    const failure = await createBackup(
      testBackupDeps(install, paths, {
        dataBytes: () => Promise.resolve(10 * 1024 ** 3),
        freeBytes: () => Promise.resolve(15 * 1024 ** 3),
      }),
      'manual',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DiskFullError);
    expect((failure as DiskFullError).free).toBe(15 * 1024 ** 3);
    expect(readdirSync(paths.backups)).toEqual([]);
  });

  it('turns a disk that fills up while writing into the same error', async () => {
    const full = () => {
      const stdout = new PassThrough();
      stdout.destroy(Object.assign(new Error('write failed'), { code: 'ENOSPC' }));
      return { stdout, finished: Promise.resolve({ code: 1, stderr: '' }) };
    };

    await expect(
      createBackup(testBackupDeps(install, paths, { startDump: full }), 'manual'),
    ).rejects.toBeInstanceOf(DiskFullError);
    expect(readdirSync(paths.backups)).toEqual([]);
  });
});

describe('keeping the backups that are known to be good', () => {
  const day = (kind: string, number: number) =>
    `consulvia-${kind}-2026-10-${String(number).padStart(2, '0')}_0900.cvb`;

  async function verified(kind: string, numbers: number[]): Promise<string[]> {
    mkdirSync(paths.backups, { recursive: true });
    const names = numbers.map((number) => day(kind, number));
    for (const name of names) {
      writeFileSync(join(paths.backups, name), 'x');
      await recordVerified(paths.backups, name, { sha256: 's', bytes: 1, verifiedAt: 'v' });
    }
    return names;
  }

  const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

  it('deletes the oldest verified daily backups beyond 14 and keeps the newest', async () => {
    const all = await verified('diaria', range(17));

    const deleted = await pruneBackups(paths.backups);

    expect(deleted).toEqual(all.slice(0, 3));
    expect(
      readdirSync(paths.backups)
        .filter((name) => name.endsWith('.cvb'))
        .sort(),
    ).toEqual(all.slice(3));
    expect(Object.keys(await readLedger(paths.backups)).sort()).toEqual(all.slice(3));
  });

  it('never deletes a file that was not verified, and does not count it as a copy to keep', async () => {
    const good = await verified('diaria', range(14));
    writeFileSync(join(paths.backups, day('diaria', 20)), 'x'); // newer, never verified
    writeFileSync(join(paths.backups, day('diaria', 21)), 'x');

    const deleted = await pruneBackups(paths.backups);

    // 14 verified copies are all there is to keep: the two unverified ones neither push them out nor go.
    expect(deleted).toEqual([]);
    for (const name of [...good, day('diaria', 20), day('diaria', 21)]) {
      expect(existsSync(join(paths.backups, name)), name).toBe(true);
    }
  });

  it('treats a file whose size changed since it was verified as unverified', async () => {
    const all = await verified('diaria', range(16));
    writeFileSync(join(paths.backups, all[0] ?? ''), 'a much longer content');

    const deleted = await pruneBackups(paths.backups);

    expect(deleted).toEqual([all[1]]);
    expect(existsSync(join(paths.backups, all[0] ?? ''))).toBe(true);
  });

  it('never goes below 7 verified backups, whatever it is asked to keep', async () => {
    const all = await verified('diaria', range(10));

    const deleted = await pruneBackups(paths.backups, { keep: { daily: 2 } });

    expect(deleted).toEqual(all.slice(0, 3));
    expect(readdirSync(paths.backups).filter((name) => name.endsWith('.cvb'))).toHaveLength(7);
  });

  it('counts the daily and the manual backups apart, so one cannot push the other out', async () => {
    const daily = await verified('diaria', range(20));
    const manual = await verified('manual', range(3));

    await pruneBackups(paths.backups);

    const left = readdirSync(paths.backups);
    for (const name of manual) expect(left).toContain(name);
    expect(left.filter((name) => name.includes('diaria'))).toHaveLength(14);
    expect(left).toContain(daily[19] ?? '');
  });

  it('keeps the three newest safety copies before a restore, and no more', async () => {
    const all = await verified('previa-restauracion', range(5));

    const deleted = await pruneBackups(paths.backups);

    expect(deleted).toEqual(all.slice(0, 2));
  });

  it('leaves files that are not backups alone', async () => {
    mkdirSync(paths.backups, { recursive: true });
    const other = [
      'notas.txt',
      'consulvia-diaria-2020-01-01_0900.cvb.partial',
      'consulvia-2020-01-01_0900.zip',
    ];
    for (const name of other) writeFileSync(join(paths.backups, name), 'x');
    await verified('diaria', range(16));

    await pruneBackups(paths.backups);

    for (const name of other) expect(readdirSync(paths.backups)).toContain(name);
  });

  it('does nothing when the folder does not exist', async () => {
    expect(await pruneBackups(join(folder, 'nowhere'))).toEqual([]);
    expect(existsSync(join(folder, 'nowhere'))).toBe(false);
  });
});

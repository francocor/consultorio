import { createHash, randomBytes } from 'node:crypto';
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
import type { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArchiveWriter } from './backup-archive.js';
import {
  FORMAT,
  keyIdOf,
  newBackupKey,
  wrapBackupKey,
  type BackupHeader,
} from './backup-crypto.js';
import {
  fakeDump,
  newTestInstall,
  testBackupDeps,
  testPaths,
  type TestInstall,
} from './backup-testing.js';
import { createBackup, type Manifest } from './backup.js';
import type { DataPaths } from './paths.js';
import {
  readBackupInfo,
  restoreBackup,
  type RestoreError,
  type AdoptedSecrets,
  type RestoreDeps,
} from './restore.js';

let folder: string;
let paths: DataPaths;
let events: string[];
let restored: Buffer[];
let restoreResult: { code: number | null; stderr: string };
let adopted: AdoptedSecrets | null;
let failSwap: boolean;
let install: TestInstall;
let other: TestInstall;

async function drain(source: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

function restoreDeps(overrides: Partial<RestoreDeps> = {}): RestoreDeps {
  return {
    paths,
    backupKey: () => install.backupKey,
    restoreDump: async (source) => {
      events.push('pg_restore');
      restored.push(await drain(source));
      return restoreResult;
    },
    scratch: {
      create: () => {
        events.push('create scratch');
        return Promise.resolve();
      },
      swapIn: () => {
        events.push('swap');
        if (failSwap) return Promise.reject(new Error('could not rename the database'));
        return Promise.resolve();
      },
      drop: () => {
        events.push('drop scratch');
        return Promise.resolve();
      },
    },
    migrationCount: 77,
    stopServices: () => {
      events.push('stop');
      return Promise.resolve();
    },
    startServices: () => {
      events.push('start');
      return Promise.resolve();
    },
    adoptSecrets: (value) => {
      adopted = value;
      events.push('adopt');
    },
    now: () => new Date(2026, 9, 25, 8, 0, 0),
    ...overrides,
  };
}

/** A backup of `source` with `documents`, as the program makes it. */
async function makeBackup(
  source: TestInstall,
  documents: Record<string, string>,
  options: { dump?: string; migrationCount?: number } = {},
) {
  rmSync(paths.files, { recursive: true, force: true });
  for (const [name, content] of Object.entries(documents)) {
    mkdirSync(join(paths.files, ...name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(paths.files, ...name.split('/')), content);
  }
  const { path } = await createBackup(
    testBackupDeps(source, paths, {
      startDump: fakeDump(options.dump ?? 'PGDMP-the-dump-of-the-backup'),
      migrationCount: options.migrationCount ?? 77,
    }),
    'manual',
  );
  return path;
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-restore-'));
  paths = testPaths(folder);
  mkdirSync(paths.root, { recursive: true });
  events = [];
  restored = [];
  restoreResult = { code: 0, stderr: '' };
  adopted = null;
  failSwap = false;
  install = newTestInstall();
  other = newTestInstall();
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const readDoc = (name: string) => readFileSync(join(paths.files, ...name.split('/')), 'utf8');

/** Nothing of the live install was touched: not the services, not the databases, not the documents. */
const untouched = () => {
  expect(events).toEqual([]);
  expect(restored).toEqual([]);
};

describe('reading a backup', () => {
  it('tells what it is from its header', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' });

    const { header } = await readBackupInfo(path);

    expect(header).toMatchObject({
      format: 2,
      migrationCount: 77,
      kind: 'manual',
      keyId: install.keyId,
    });
  });

  it('refuses a file that is not a backup of Consulvia: a zip, text, an empty file, a missing file', async () => {
    const zip = join(folder, 'a.zip');
    writeFileSync(zip, Buffer.from('PK\u0003\u0004 plain zip bytes'));
    const text = join(folder, 'notes.cvb');
    writeFileSync(text, 'this is not a backup');
    const empty = join(folder, 'empty.cvb');
    writeFileSync(empty, '');

    for (const file of [zip, text, empty, join(folder, 'missing.cvb')]) {
      await expect(readBackupInfo(file), file).rejects.toMatchObject({ code: 'invalid_backup' });
    }
  });
});

describe('restoring a backup of this installation', () => {
  it('stops the services, restores into a scratch database, swaps the documents and the database, and starts again', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'from the backup' });
    rmSync(paths.files, { recursive: true, force: true });
    mkdirSync(join(paths.files, 't', 'a', 'docs'), { recursive: true });
    writeFileSync(join(paths.files, 't', 'a', 'docs', 'newer.obj'), 'made after the backup');

    await restoreBackup(restoreDeps(), path);

    expect(events).toEqual(['stop', 'create scratch', 'pg_restore', 'swap', 'start']);
    expect(restored.map((dump) => dump.toString())).toEqual(['PGDMP-the-dump-of-the-backup']);
    expect(readDoc('t/a/docs/1.obj')).toBe('from the backup');
    expect(existsSync(join(paths.files, 't', 'a', 'docs', 'newer.obj'))).toBe(false);
    expect(adopted).toBeNull();
  });

  it('leaves no scratch folder and no old documents folder behind', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' });

    await restoreBackup(restoreDeps(), path);

    expect(readdirSync(paths.root).filter((name) => /^tmp-restore|replaced/.test(name))).toEqual(
      [],
    );
  });

  it('changes nothing when pg_restore fails, drops the scratch database and starts the services again', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'from the backup' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'current data');
    restoreResult = { code: 1, stderr: 'pg_restore: error: could not execute query\n' };

    const failure = await restoreBackup(restoreDeps(), path).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'restore_failed' });
    expect((failure as RestoreError).detail).toContain('could not execute query');
    expect(readDoc('t/a/docs/1.obj')).toBe('current data');
    expect(events).toEqual(['stop', 'create scratch', 'pg_restore', 'drop scratch', 'start']);
  });

  it('puts the old documents back when the database cannot be swapped in', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'from the backup' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'current data');
    failSwap = true;

    await expect(restoreBackup(restoreDeps(), path)).rejects.toThrow(
      'could not rename the database',
    );

    expect(readDoc('t/a/docs/1.obj')).toBe('current data');
    expect(events).toEqual([
      'stop',
      'create scratch',
      'pg_restore',
      'swap',
      'drop scratch',
      'start',
    ]);
  });

  it('refuses a backup made by a newer version, before it touches anything', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' }, { migrationCount: 80 });

    await expect(restoreBackup(restoreDeps(), path)).rejects.toMatchObject({
      code: 'newer_version',
    });
    untouched();
  });

  it('accepts a backup made by an older version', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' }, { migrationCount: 60 });

    await restoreBackup(restoreDeps(), path);

    expect(events).toEqual(['stop', 'create scratch', 'pg_restore', 'swap', 'start']);
  });
});

describe('a backup that is not what it claims', () => {
  function tamper(path: string, change: (bytes: Buffer) => Buffer): string {
    const bad = join(folder, 'bad.cvb');
    writeFileSync(bad, change(readFileSync(path)));
    return bad;
  }

  it('is refused, with nothing read, when a byte of it was changed', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' });
    const bad = tamper(path, (bytes) => {
      const copy = Buffer.from(bytes);
      const at = copy.length - 40;
      copy[at] = (copy[at] ?? 0) ^ 0x80;
      return copy;
    });

    await expect(restoreBackup(restoreDeps(), bad)).rejects.toMatchObject({
      code: 'tampered_backup',
    });
    untouched();
  });

  it('is refused, with nothing read, when it was cut short', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' });
    const bad = tamper(path, (bytes) => bytes.subarray(0, bytes.length - 30));

    await expect(restoreBackup(restoreDeps(), bad)).rejects.toMatchObject({
      code: 'tampered_backup',
    });
    untouched();
  });

  it("is refused when someone else made it and gave it this installation's name (a planted backup)", async () => {
    // The attacker knows the format and copies the key id of the victim, but cannot know the backup key.
    const attackerKey = newBackupKey();
    const header: BackupHeader = {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      appVersion: '0.1.0',
      migrationCount: 77,
      kind: 'manual',
      keyId: install.keyId,
      fileSalt: randomBytes(32).toString('base64'),
      wrap: wrapBackupKey(attackerKey, 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF'),
    };
    const planted = join(folder, 'planted.cvb');
    const writer = createArchiveWriter(planted, attackerKey, header);
    await writer.addBuffer('db.dump', "COPY (SELECT 1) TO PROGRAM 'calc.exe';");
    await writer.addBuffer('secrets.json', JSON.stringify(install.secrets));
    await writer.addBuffer('manifest.json', '{}');
    await writer.finish();

    await expect(restoreBackup(restoreDeps(), planted)).rejects.toMatchObject({
      code: 'tampered_backup',
    });
    untouched();
  });

  it("is refused when it was sealed with the attacker's key and wrapped with a recovery key they typed", async () => {
    const attackerKey = newBackupKey();
    const attackerRecovery = 'GGGGG-HHHHH-JJJJJ-KKKKK-LLLLL-MMMMM';
    const header: BackupHeader = {
      format: FORMAT,
      createdAt: new Date().toISOString(),
      appVersion: '0.1.0',
      migrationCount: 77,
      kind: 'manual',
      keyId: keyIdOf(attackerKey),
      fileSalt: randomBytes(32).toString('base64'),
      wrap: wrapBackupKey(attackerKey, attackerRecovery),
    };
    const planted = join(folder, 'planted.cvb');
    const writer = createArchiveWriter(planted, attackerKey, header);
    await writer.addBuffer('db.dump', 'PGDMP');
    await writer.finish();

    // Without the recovery key of the victim's own backups, a foreign file asks for a key: it never runs.
    await expect(restoreBackup(restoreDeps(), planted)).rejects.toMatchObject({
      code: 'recovery_key_required',
    });
    // With a key that does not unwrap it, it is refused too.
    await expect(
      restoreBackup(restoreDeps(), planted, { recoveryKey: install.recoveryKey }),
    ).rejects.toMatchObject({ code: 'wrong_recovery_key' });
    untouched();
  });

  describe('even when it authenticates (its maker has the key), what it holds is checked', () => {
    async function craft(
      entries: Record<string, string> | [string, string][],
      extra?: Partial<RestoreDeps>,
    ) {
      const header: BackupHeader = {
        format: FORMAT,
        createdAt: new Date().toISOString(),
        appVersion: '0.1.0',
        migrationCount: 77,
        kind: 'manual',
        keyId: install.keyId,
        fileSalt: randomBytes(32).toString('base64'),
        wrap: install.wrap,
      };
      const file = join(folder, 'crafted.cvb');
      const writer = createArchiveWriter(file, install.backupKey, header);
      for (const [name, content] of Array.isArray(entries) ? entries : Object.entries(entries)) {
        await writer.addBuffer(name, content);
      }
      await writer.finish();
      return restoreBackup(restoreDeps(extra), file);
    }

    const manifestFor = (dump: string, fileCount = 0): string =>
      JSON.stringify({
        dumpBytes: dump.length,
        dumpSha256: createHash('sha256').update(dump).digest('hex'),
        fileCount,
        fileBytes: 0,
      } satisfies Manifest);

    it('refuses an entry that climbs out of the documents folder', async () => {
      const failure = await craft({
        'db.dump': 'PGDMP',
        'secrets.json': JSON.stringify(install.secrets),
        'files/../../outside.txt': 'x',
        'manifest.json': manifestFor('PGDMP', 1),
      }).catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'invalid_backup' });
      expect(existsSync(join(paths.root, '..', 'outside.txt'))).toBe(false);
      expect(events).toContain('drop scratch');
      expect(events).not.toContain('swap');
    });

    it('refuses an entry it does not know', async () => {
      await expect(
        craft({
          'db.dump': 'PGDMP',
          'secrets.json': JSON.stringify(install.secrets),
          'run.bat': 'calc',
        }),
      ).rejects.toMatchObject({ code: 'invalid_backup' });
      expect(events).not.toContain('swap');
    });

    it('refuses two dumps', async () => {
      await expect(
        craft([
          ['db.dump', 'PGDMP'],
          ['secrets.json', JSON.stringify(install.secrets)],
          ['db.dump', 'PGDMP again'],
        ]),
      ).rejects.toMatchObject({ code: 'invalid_backup' });
      expect(events).not.toContain('swap');
    });

    it('refuses a manifest that does not match the dump or the documents', async () => {
      await expect(
        craft({
          'db.dump': 'PGDMP',
          'secrets.json': JSON.stringify(install.secrets),
          'manifest.json': manifestFor('another dump'),
        }),
      ).rejects.toMatchObject({ code: 'invalid_backup' });
      expect(events).not.toContain('swap');
    });

    it('refuses a backup with no manifest or no secrets', async () => {
      await expect(
        craft({ 'db.dump': 'PGDMP', 'secrets.json': JSON.stringify(install.secrets) }),
      ).rejects.toMatchObject({ code: 'invalid_backup' });
      await expect(
        craft({ 'db.dump': 'PGDMP', 'manifest.json': manifestFor('PGDMP') }),
      ).rejects.toMatchObject({ code: 'invalid_backup' });
    });

    it('refuses a backup with more entries than the limit', async () => {
      const many: Record<string, string> = { 'db.dump': 'PGDMP' };
      for (let index = 0; index < 20; index += 1) many[`files/t/${String(index)}.obj`] = 'x';

      await expect(
        craft(many, { limits: { maxEntries: 5, maxBytes: 1024 * 1024, maxNameBytes: 1024 } }),
      ).rejects.toMatchObject({ code: 'tampered_backup' });
      untouched();
    });
  });
});

describe('restoring a backup of another installation', () => {
  it('asks for the recovery key before it touches anything', async () => {
    const path = await makeBackup(other, { 't/a/docs/1.obj': 'theirs' });

    await expect(restoreBackup(restoreDeps(), path)).rejects.toMatchObject({
      code: 'recovery_key_required',
    });
    await expect(restoreBackup(restoreDeps(), path, { recoveryKey: '  ' })).rejects.toMatchObject({
      code: 'recovery_key_required',
    });
    untouched();
  });

  it('refuses a wrong key without touching anything', async () => {
    const path = await makeBackup(other, { 't/a/docs/1.obj': 'theirs' });

    await expect(
      restoreBackup(restoreDeps(), path, { recoveryKey: install.recoveryKey }),
    ).rejects.toMatchObject({ code: 'wrong_recovery_key' });
    untouched();
  });

  it('adopts the secrets, the backup key and the typed recovery key once the data is in place', async () => {
    const path = await makeBackup(other, { 't/a/docs/1.obj': 'theirs' });

    await restoreBackup(restoreDeps(), path, {
      recoveryKey: other.recoveryKey.toLowerCase().replaceAll('-', ' '),
    });

    expect(events).toEqual(['stop', 'create scratch', 'pg_restore', 'swap', 'adopt', 'start']);
    expect(adopted).toMatchObject({
      payload: other.secrets,
      backupKeyBase64: other.backupKey.toString('base64'),
      backupKeyWrap: other.wrap,
      recoveryKey: other.recoveryKey,
    });
    expect(readDoc('t/a/docs/1.obj')).toBe('theirs');
  });

  it('does not adopt anything when the database restore fails', async () => {
    const path = await makeBackup(other, { 't/a/docs/1.obj': 'theirs' });
    restoreResult = { code: 1, stderr: 'boom' };

    await expect(
      restoreBackup(restoreDeps(), path, { recoveryKey: other.recoveryKey }),
    ).rejects.toMatchObject({
      code: 'restore_failed',
    });

    expect(adopted).toBeNull();
  });
});

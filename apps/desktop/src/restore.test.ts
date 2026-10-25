import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
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
import { DiskFullError } from './disk.js';
import type { DataPaths } from './paths.js';
import {
  auditProblems,
  revertStatements,
  type ClusterFacts,
  type ScratchFacts,
} from './restore-audit.js';
import {
  ASIDE_DATABASE,
  DATABASE,
  SCRATCH_DATABASE,
  journalFile,
  readJournal,
  reconcileInterruptedRestore,
  type ReconcileDeps,
} from './restore-journal.js';
import {
  readBackupInfo,
  restoreBackup,
  type RestoreCheckpoint,
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
/** What the cluster looks like before the restore, and what the restored database left behind. */
const CLEAN: ClusterFacts = {
  memberships: [
    {
      role: 'audit_sealer',
      member: 'app_owner',
      grantor: 'postgres',
      admin: true,
      inherit: false,
      set: false,
    },
  ],
  roleSettings: [],
  ownerPasswordHash: 'SCRAM-SHA-256$4096:aaa$bbb:ccc',
  auditPrivileges: ['app_rw:INSERT:audit_event'],
};
let leftBehind: { cluster: ClusterFacts; scratch: ScratchFacts };
let reverted: string[][];
let failSwap: boolean;
let failAdopt: boolean;
/** The databases of the cluster and what is in each: `consultorio` is the real one. */
let db: Map<string, string>;
/** After the process died nothing of it runs any more: no clean up, no restart. */
let dead: boolean;
/** Where the fake swap of the databases stops, as a crash would. */
let swapStops: 'after-first-rename' | 'after-second-rename' | null;
/** The swap stops because the whole process died, not because it reported an error. */
let swapKills: boolean;
const OLD_DB = 'the database of before';
const NEW_DB = 'the database of the backup';
const OLD_CONFIG = 'the configuration of this install';
const NEW_CONFIG = 'the configuration with the keys of the backup';
let install: TestInstall;
let other: TestInstall;

async function drain(source: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

/** The cluster as the code that undoes a restore sees it. */
function fakeDatabases(): ReconcileDeps['databases'] {
  return {
    names: () => Promise.resolve([...db.keys()]),
    rename: (from, to) => {
      db.set(to, db.get(from) ?? '');
      db.delete(from);
      return Promise.resolve();
    },
    drop: (name) => {
      if (name === SCRATCH_DATABASE) events.push('drop scratch');
      db.delete(name);
      return Promise.resolve();
    },
  };
}

function reconcileDeps(): ReconcileDeps {
  return {
    paths,
    databases: fakeDatabases(),
    reloadConfig: () => {
      events.push('reload secrets');
    },
  };
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
        db.set(SCRATCH_DATABASE, NEW_DB);
        return Promise.resolve();
      },
      swapIn: () => {
        events.push('swap');
        if (failSwap) return Promise.reject(new Error('could not rename the database'));
        const databases = fakeDatabases();
        return (async () => {
          await databases.rename(DATABASE, ASIDE_DATABASE);
          if (swapStops === 'after-first-rename') {
            dead = swapKills;
            throw new Error('the process died');
          }
          await databases.rename(SCRATCH_DATABASE, DATABASE);
          if (swapStops === 'after-second-rename') {
            dead = swapKills;
            throw new Error('the process died');
          }
          await databases.drop(ASIDE_DATABASE);
        })();
      },
    },
    reconcile: () =>
      dead
        ? Promise.resolve('none')
        : reconcileInterruptedRestore({ ...reconcileDeps(), sweep: false }),
    migrationCount: 77,
    stopServices: () => {
      events.push('stop');
      return Promise.resolve();
    },
    startServices: () => {
      if (dead) return Promise.resolve();
      events.push('start');
      return Promise.resolve();
    },
    adoptSecrets: (value) => {
      adopted = value;
      events.push('adopt');
      if (failAdopt) throw new Error('could not write config.json');
      writeFileSync(paths.configFile, NEW_CONFIG);
    },
    audit: {
      snapshot: () => Promise.resolve(CLEAN),
      check: () => Promise.resolve(auditProblems(CLEAN, leftBehind.cluster, leftBehind.scratch)),
      revert: () => {
        events.push('revert roles');
        reverted.push(revertStatements(CLEAN, leftBehind.cluster, 'owner-password'));
        return Promise.resolve();
      },
    },
    dataBytes: () => Promise.resolve(1000),
    freeBytes: () => Promise.resolve(10 ** 13),
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
  failAdopt = false;
  db = new Map([[DATABASE, OLD_DB]]);
  dead = false;
  swapStops = null;
  swapKills = false;
  leftBehind = { cluster: CLEAN, scratch: { migrationsKind: 'r', databaseSettings: [] } };
  reverted = [];
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

    expect(events).toEqual([
      'stop',
      'create scratch',
      'pg_restore',
      'swap',
      'revert roles',
      'start',
    ]);
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

  it('keeps the rows pg_restore failed on out of the error, which ends in the log', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' });
    restoreResult = {
      code: 1,
      stderr: [
        'pg_restore: error: COPY failed for table "patient": ERROR:  invalid input syntax for type date: "12/03/1985"',
        'CONTEXT:  COPY patient, line 3, column birth_date: "12/03/1985"',
        "Command was: INSERT INTO patient VALUES ('Ana Gomez', '30123456');",
      ].join('\n'),
    };

    const failure = (await restoreBackup(restoreDeps(), path).catch(
      (error: unknown) => error,
    )) as RestoreError;

    expect(failure.code).toBe('restore_failed');
    expect(failure.detail).toContain('COPY failed for table');
    for (const leak of ['12/03/1985', 'Ana Gomez', '30123456', 'CONTEXT']) {
      expect(failure.detail, leak).not.toContain(leak);
    }
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

    expect(events).toEqual([
      'stop',
      'create scratch',
      'pg_restore',
      'swap',
      'revert roles',
      'start',
    ]);
  });
});

describe('a restore that fails half way, or is cut off', () => {
  async function foreignBackup() {
    const path = await makeBackup(other, { 't/a/docs/1.obj': 'theirs' });
    mkdirSync(join(paths.files, 't', 'a', 'docs'), { recursive: true });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'ours');
    writeFileSync(paths.configFile, OLD_CONFIG);
    return path;
  }

  it('puts the old keys, the old documents and the services back when the databases cannot trade places', async () => {
    const path = await foreignBackup();
    failSwap = true;

    await expect(
      restoreBackup(restoreDeps(), path, { recoveryKey: other.recoveryKey }),
    ).rejects.toThrow('could not rename the database');

    expect(readFileSync(paths.configFile, 'utf8')).toBe(OLD_CONFIG);
    expect(readDoc('t/a/docs/1.obj')).toBe('ours');
    expect(events).toEqual([
      'stop',
      'create scratch',
      'pg_restore',
      'adopt',
      'swap',
      'drop scratch',
      'reload secrets',
      'start',
    ]);
    expect(existsSync(journalFile(paths))).toBe(false);
    expect(
      readdirSync(paths.root).filter((name) => /pre-restore|tmp-restore|replaced/.test(name)),
    ).toEqual([]);
  });

  it('puts the old keys back when adopting the new ones fails half way, and never swaps the databases', async () => {
    const path = await foreignBackup();
    failAdopt = true;

    await expect(
      restoreBackup(restoreDeps(), path, { recoveryKey: other.recoveryKey }),
    ).rejects.toThrow('could not write config.json');

    expect(readFileSync(paths.configFile, 'utf8')).toBe(OLD_CONFIG);
    expect(readDoc('t/a/docs/1.obj')).toBe('ours');
    expect(events).not.toContain('swap');
    expect(events).toContain('reload secrets');
    expect(events).toContain('drop scratch');
  });

  it('never rolls anything back once the databases have traded places: it says the restore is incomplete', async () => {
    const path = await foreignBackup();
    let calls = 0;
    const failure = await restoreBackup(
      restoreDeps({
        startServices: () => {
          events.push('start');
          calls += 1;
          return Promise.reject(new Error('the api did not answer'));
        },
      }),
      path,
      { recoveryKey: other.recoveryKey },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'restore_incomplete' });
    expect(calls).toBe(1);
    // The documents and the keys of the backup stay: the database that is in place needs them.
    expect(readDoc('t/a/docs/1.obj')).toBe('theirs');
    expect(readFileSync(paths.configFile, 'utf8')).toBe(
      'the configuration with the keys of the backup',
    );
    expect(events).not.toContain('reload secrets');
    expect(events).not.toContain('drop scratch');
    // And what was waiting to be undone is gone: there is nothing to undo any more.
    expect(existsSync(journalFile(paths))).toBe(false);
    expect(
      readdirSync(paths.root).filter((name) => /pre-restore|tmp-restore|replaced/.test(name)),
    ).toEqual([]);
  });

  it('writes down how far it got, before each step that cannot be repeated', async () => {
    const path = await foreignBackup();
    const seen: string[] = [];
    const step = async () =>
      ((await readJournal(paths)) as { step: string } | null)?.step ?? 'none';

    await restoreBackup(
      restoreDeps({
        restoreDump: async (source) => {
          seen.push(`pg_restore: ${await step()}`);
          await drain(source);
          return { code: 0, stderr: '' };
        },
        adoptSecrets: async () => {
          seen.push(`adopt: ${await step()}`);
        },
        scratch: {
          create: () => Promise.resolve(),
          swapIn: async () => {
            seen.push(`swap: ${await step()}`);
          },
        },
      }),
      path,
      { recoveryKey: other.recoveryKey },
    );

    expect(seen).toEqual(['pg_restore: restoring', 'adopt: secrets-adopted', 'swap: swapping']);
    expect(existsSync(journalFile(paths))).toBe(false);
    expect(await readJournal(paths)).toBeNull();
  });

  it('refuses before it touches anything when the disk cannot hold what the backup expands to', async () => {
    // What counts is what the file holds once unpacked, which pass 1 measures: not the size of the file.
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'x'.repeat(200_000) });

    const failure = await restoreBackup(
      restoreDeps({ freeBytes: () => Promise.resolve(64 * 1024 * 1024 + 100_000) }),
      path,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DiskFullError);
    untouched();
    expect(existsSync(journalFile(paths))).toBe(false);
  });

  it('counts the documents at their unpacked size even when they compress to almost nothing', async () => {
    // 3 MiB of zeros is a few kilobytes in the file and 3 MiB on the disk.
    const path = await makeBackup(install, { 't/a/docs/1.obj': '0'.repeat(3 * 1024 * 1024) });
    const { size } = statSync(path);
    expect(size).toBeLessThan(100_000);

    const failure = await restoreBackup(
      restoreDeps({ freeBytes: () => Promise.resolve(64 * 1024 * 1024 + 2 * 1024 * 1024) }),
      path,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DiskFullError);
    untouched();
  });

  it('stops reading as soon as the unpacked size passes the free space, instead of reading a bomb to the end', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': '0'.repeat(8 * 1024 * 1024) });
    let reads = 0;

    const failure = await restoreBackup(
      restoreDeps({
        freeBytes: () => {
          reads += 1;
          return Promise.resolve(64 * 1024 * 1024 + 1024);
        },
      }),
      path,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DiskFullError);
    expect((failure as DiskFullError).needed).toBeGreaterThan((failure as DiskFullError).free);
    // The free space is read once, before pass 1 begins.
    expect(reads).toBe(1);
    untouched();
  });

  it('restores when there is room for what the backup expands to', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': '0'.repeat(1024 * 1024) });

    await restoreBackup(
      restoreDeps({ freeBytes: () => Promise.resolve(64 * 1024 * 1024 + 50 * 1024 * 1024) }),
      path,
    );

    expect(events).toContain('swap');
  });
});

describe('a backup that authenticates but does things a backup has no business doing', () => {
  const refused = async (change: () => void) => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'from the backup' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'current data');
    change();

    const failure = await restoreBackup(restoreDeps(), path).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'unsafe_backup' });
    // Before the swap: the databases never traded places, the documents are the current ones, the scratch is gone.
    expect(events).not.toContain('swap');
    expect(events).toContain('drop scratch');
    expect(events).toContain('revert roles');
    expect(readDoc('t/a/docs/1.obj')).toBe('current data');
    expect(existsSync(journalFile(paths))).toBe(false);
    return failure as RestoreError;
  };

  it('refuses a dump that made the table of the migrations a view, which the superuser used to read at boot', async () => {
    const failure = await refused(() => {
      leftBehind = { ...leftBehind, scratch: { migrationsKind: 'v', databaseSettings: [] } };
    });

    expect(failure.detail).toContain('is not a table');
  });

  it('refuses a dump that sets a parameter of the database', async () => {
    const failure = await refused(() => {
      leftBehind = {
        ...leftBehind,
        scratch: { migrationsKind: 'r', databaseSettings: ['search_path=evil'] },
      };
    });

    expect(failure.detail).toContain('search_path=evil');
  });

  it('refuses a dump that grants audit_sealer to another role, and says which statement would undo it', async () => {
    const failure = await refused(() => {
      leftBehind = {
        ...leftBehind,
        cluster: {
          ...CLEAN,
          memberships: [
            ...CLEAN.memberships,
            {
              role: 'audit_sealer',
              member: 'app_rw',
              grantor: 'app_owner',
              admin: false,
              inherit: false,
              set: true,
            },
          ],
        },
      };
    });

    expect(failure.detail).toContain('audit_sealer to app_rw');
    expect(reverted[0]).toEqual(['REVOKE "audit_sealer" FROM "app_rw" GRANTED BY "app_owner"']);
  });

  it('refuses a dump that opens the audit trail to the application role', async () => {
    const failure = await refused(() => {
      leftBehind = {
        ...leftBehind,
        cluster: {
          ...CLEAN,
          auditPrivileges: [...CLEAN.auditPrivileges, 'app_rw:UPDATE:audit_event'],
        },
      };
    });

    expect(failure.detail).toContain('app_rw:UPDATE:audit_event');
  });

  it('lets a clean backup through, and re-applies the known state after the swap', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'one' });

    await restoreBackup(restoreDeps(), path);

    expect(events).toEqual([
      'stop',
      'create scratch',
      'pg_restore',
      'swap',
      'revert roles',
      'start',
    ]);
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

    // The keys are adopted before the databases trade places, with a way back.
    expect(events).toEqual([
      'stop',
      'create scratch',
      'pg_restore',
      'adopt',
      'swap',
      'revert roles',
      'start',
    ]);
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

/** Everything a restore leaves in the data folder besides the data itself. */
const leftovers = () =>
  readdirSync(paths.root).filter((name) => /pre-restore|tmp-restore|replaced/.test(name));

describe('a process that dies at any point of a restore', () => {
  const POINTS: (RestoreCheckpoint | 'swap-1' | 'swap-2')[] = [
    'prepared',
    'restoring',
    'files-swapping',
    'files-aside',
    'files-in-place',
    'files-swapped',
    'secrets-step',
    'secrets-adopted',
    'swapping',
    'swap-1',
    'swap-2',
    'swapped',
  ];
  /** The points after which the restored database is the real one. */
  const DATABASE_SWAPPED = new Set(['swap-2', 'swapped']);

  /** Sets up a current install with its data, makes a backup of `source`, and kills the restore at `point`. */
  async function dieAt(point: RestoreCheckpoint | 'swap-1' | 'swap-2', foreign: boolean) {
    const path = await makeBackup(foreign ? other : install, { 't/a/docs/1.obj': 'theirs' });
    rmSync(paths.files, { recursive: true, force: true });
    mkdirSync(join(paths.files, 't', 'a', 'docs'), { recursive: true });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'ours');
    writeFileSync(paths.configFile, OLD_CONFIG);
    swapKills = true;
    if (point === 'swap-1') swapStops = 'after-first-rename';
    if (point === 'swap-2') swapStops = 'after-second-rename';
    const failure = await restoreBackup(
      restoreDeps({
        checkpoint: (reachedPoint) => {
          if (reachedPoint === point) {
            dead = true;
            throw new Error('the process died');
          }
        },
      }),
      path,
      foreign ? { recoveryKey: other.recoveryKey } : {},
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    dead = true;
    swapStops = null;
    swapKills = false;
  }

  const coherent = (swapped: boolean, foreign: boolean) => {
    expect([...db.entries()]).toEqual([[DATABASE, swapped ? NEW_DB : OLD_DB]]);
    expect(readDoc('t/a/docs/1.obj')).toBe(swapped ? 'theirs' : 'ours');
    expect(readFileSync(paths.configFile, 'utf8')).toBe(
      swapped && foreign ? NEW_CONFIG : OLD_CONFIG,
    );
    expect(existsSync(journalFile(paths))).toBe(false);
    expect(leftovers()).toEqual([]);
  };

  for (const foreign of [false, true]) {
    for (const point of POINTS) {
      if (!foreign && (point === 'secrets-step' || point === 'secrets-adopted')) continue;
      it(`start up finds one coherent state after a death at "${point}" (${foreign ? 'a backup of another install' : 'a backup of this install'})`, async () => {
        await dieAt(point, foreign);

        await reconcileInterruptedRestore(reconcileDeps());

        coherent(DATABASE_SWAPPED.has(point), foreign);
        // And again: starting twice changes nothing.
        await reconcileInterruptedRestore(reconcileDeps());
        coherent(DATABASE_SWAPPED.has(point), foreign);
      });
    }
  }

  it('finds the same state when the clean up itself dies on any of its database steps and is run again', async () => {
    for (const point of ['files-aside', 'secrets-adopted', 'swap-1', 'swap-2'] as const) {
      for (let failing = 1; failing <= 3; failing += 1) {
        rmSync(paths.root, { recursive: true, force: true });
        mkdirSync(paths.root, { recursive: true });
        db = new Map([[DATABASE, OLD_DB]]);
        events = [];
        dead = false;
        await dieAt(point, true);

        let calls = 0;
        const flaky = fakeDatabases();
        const dying =
          <Arguments extends string[]>(operation: (...values: Arguments) => Promise<void>) =>
          (...values: Arguments) => {
            calls += 1;
            if (calls === failing) return Promise.reject(new Error('the process died'));
            return operation(...values);
          };
        await reconcileInterruptedRestore({
          ...reconcileDeps(),
          databases: { names: flaky.names, rename: dying(flaky.rename), drop: dying(flaky.drop) },
        }).catch(() => 'died');

        await reconcileInterruptedRestore(reconcileDeps());
        coherent(DATABASE_SWAPPED.has(point), true);
      }
    }
  });

  it('is not confused by a copy that an earlier clean up already deleted', async () => {
    await dieAt('secrets-adopted', true);
    for (const name of readdirSync(paths.root)) {
      if (/pre-restore|tmp-restore/.test(name)) rmSync(join(paths.root, name), { recursive: true });
    }

    await reconcileInterruptedRestore(reconcileDeps());

    expect(readDoc('t/a/docs/1.obj')).toBe('ours');
    expect(existsSync(journalFile(paths))).toBe(false);
  });

  it('puts the documents back when the install had none, by removing what the backup brought', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'theirs' });
    rmSync(paths.files, { recursive: true, force: true });

    await restoreBackup(
      restoreDeps({
        checkpoint: (point) => {
          if (point === 'files-in-place') {
            dead = true;
            throw new Error('the process died');
          }
        },
      }),
      path,
    ).catch(() => undefined);
    expect(existsSync(paths.files)).toBe(true);

    await reconcileInterruptedRestore(reconcileDeps());

    expect(existsSync(paths.files)).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe('a restore that fails inside the process, and what it leaves', () => {
  it('finishes the restore when the databases traded places and the swap still reported an error', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'theirs' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'ours');
    swapStops = 'after-second-rename';

    await restoreBackup(restoreDeps(), path);

    expect([...db.entries()]).toEqual([[DATABASE, NEW_DB]]);
    expect(readDoc('t/a/docs/1.obj')).toBe('theirs');
    expect(events.at(-1)).toBe('start');
    expect(leftovers()).toEqual([]);
  });

  it('puts the name of the old database back when the swap stops between the two renames', async () => {
    const path = await makeBackup(install, { 't/a/docs/1.obj': 'theirs' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'ours');
    swapStops = 'after-first-rename';

    await expect(restoreBackup(restoreDeps(), path)).rejects.toThrow('the process died');

    expect([...db.entries()]).toEqual([[DATABASE, OLD_DB]]);
    expect(readDoc('t/a/docs/1.obj')).toBe('ours');
    expect(events.at(-1)).toBe('start');
  });

  it('keeps the journal and the copies, starts nothing and says so when it cannot put everything back', async () => {
    const path = await makeBackup(other, { 't/a/docs/1.obj': 'theirs' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'ours');
    writeFileSync(paths.configFile, OLD_CONFIG);
    failSwap = true;

    const failure = await restoreBackup(
      restoreDeps({
        reconcile: () =>
          reconcileInterruptedRestore({
            ...reconcileDeps(),
            databases: {
              ...fakeDatabases(),
              drop: () => Promise.reject(new Error('the database is busy')),
            },
          }),
      }),
      path,
      { recoveryKey: other.recoveryKey },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'undo_incomplete' });
    expect(events).not.toContain('start');
    // Everything the next start needs to finish the job is still there.
    expect(existsSync(journalFile(paths))).toBe(true);
    expect(leftovers().some((name) => name.startsWith('config.json.pre-restore-'))).toBe(true);

    await reconcileInterruptedRestore(reconcileDeps());

    expect([...db.entries()]).toEqual([[DATABASE, OLD_DB]]);
    expect(readDoc('t/a/docs/1.obj')).toBe('ours');
    expect(readFileSync(paths.configFile, 'utf8')).toBe(OLD_CONFIG);
    expect(existsSync(journalFile(paths))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('starts nothing when the secrets cannot be read again, and the next start undoes it all, although the scratch database is already gone', async () => {
    const path = await makeBackup(other, { 't/a/docs/1.obj': 'theirs' });
    writeFileSync(join(paths.files, 't', 'a', 'docs', '1.obj'), 'ours');
    writeFileSync(paths.configFile, OLD_CONFIG);
    failSwap = true;

    const failure = await restoreBackup(
      restoreDeps({
        reconcile: () =>
          reconcileInterruptedRestore({
            ...reconcileDeps(),
            reloadConfig: () => {
              throw new Error('config.json is locked');
            },
          }),
      }),
      path,
      { recoveryKey: other.recoveryKey },
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'undo_incomplete' });
    expect(db.has(SCRATCH_DATABASE)).toBe(false);

    await reconcileInterruptedRestore(reconcileDeps());

    expect([...db.entries()]).toEqual([[DATABASE, OLD_DB]]);
    expect(readDoc('t/a/docs/1.obj')).toBe('ours');
    expect(readFileSync(paths.configFile, 'utf8')).toBe(OLD_CONFIG);
    expect(existsSync(journalFile(paths))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

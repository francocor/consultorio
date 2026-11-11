import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { testPaths } from './backup-testing.js';
import type { DataPaths } from './paths.js';
import {
  ASIDE_DATABASE,
  DATABASE,
  SCRATCH_DATABASE,
  clearJournal,
  journalFile,
  readJournal,
  reconcileInterruptedRestore,
  writeJournal,
  type RestoreJournal,
  type RestoreStep,
} from './restore-journal.js';

let folder: string;
let paths: DataPaths;
let databases: string[];
let calls: string[];
let reloads: number;
let roleDrops: number;
let roleDropFails: boolean;
let logged: string[];
/** What the fake `revertRoles` was given, and whether it fails. */
let revertedRoles: unknown[];
let revertRolesFails: boolean;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-journal-'));
  paths = testPaths(folder);
  mkdirSync(paths.root, { recursive: true });
  databases = [DATABASE];
  calls = [];
  reloads = 0;
  roleDrops = 0;
  roleDropFails = false;
  logged = [];
  revertedRoles = [];
  revertRolesFails = false;
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

const aside = () => `${paths.files}.replaced-1`;

function journal(step: RestoreStep, configCopy: string | null = null): RestoreJournal {
  return {
    version: 1,
    stamp: '1',
    step,
    filesAside: aside(),
    unpacked: join(paths.root, 'tmp-restore-1'),
    configCopy,
    hadFiles: true,
    undoing: false,
    roles: null,
  };
}

function reconcile() {
  return reconcileInterruptedRestore({
    paths,
    databases: {
      names: () => Promise.resolve([...databases]),
      rename: (from, to) => {
        calls.push(`rename ${from} ${to}`);
        databases = databases.map((name) => (name === from ? to : name));
        return Promise.resolve();
      },
      drop: (name) => {
        calls.push(`drop ${name}`);
        databases = databases.filter((candidate) => candidate !== name);
        return Promise.resolve();
      },
      dropRestoreRoles: () => {
        roleDrops += 1;
        return roleDropFails
          ? Promise.reject(new Error('still owns something'))
          : Promise.resolve();
      },
    },
    revertRoles: (snapshot) => {
      calls.push('revert roles');
      if (revertRolesFails) return Promise.reject(new Error('the server refused'));
      revertedRoles.push(snapshot);
      return Promise.resolve();
    },
    reloadConfig: () => {
      reloads += 1;
    },
    log: (message) => {
      logged.push(message);
    },
  });
}

/** The documents as a restore leaves them half way: the backup's in place, the old ones aside. */
function filesHalfSwapped() {
  mkdirSync(paths.files, { recursive: true });
  writeFileSync(join(paths.files, 'from-the-backup.obj'), 'backup');
  mkdirSync(aside(), { recursive: true });
  writeFileSync(join(aside(), 'old.obj'), 'old');
  mkdirSync(join(paths.root, 'tmp-restore-1', 'files'), { recursive: true });
}

describe('the journal of a restore', () => {
  it('is written whole and read back, and removed when the restore is over', async () => {
    await writeJournal(paths, journal('restoring', '/tmp/copy'));

    expect(await readJournal(paths)).toEqual(journal('restoring', '/tmp/copy'));

    await clearJournal(paths);
    expect(await readJournal(paths)).toBeNull();
  });

  it('tries again when the file is busy (an antivirus scanning it) and gives up with the error after the last try', async () => {
    await writeJournal(paths, journal('restoring', null));
    let calls = 0;
    const busy = Object.assign(new Error('resource busy'), { code: 'EBUSY' });

    await clearJournal(paths, {
      remove: async (path) => {
        calls += 1;
        if (calls < 3) throw busy;
        await rm(path, { force: true });
      },
      delayMs: 0,
    });

    expect(calls).toBe(3);
    expect(await readJournal(paths)).toBeNull();

    calls = 0;
    await expect(
      clearJournal(paths, {
        remove: () => {
          calls += 1;
          return Promise.reject(busy);
        },
        attempts: 4,
        delayMs: 0,
      }),
    ).rejects.toBe(busy);
    expect(calls).toBe(4);
  });

  it('says so when the file is there but nobody can read it', async () => {
    writeFileSync(journalFile(paths), '{ not json');
    expect(await readJournal(paths)).toBe('unreadable');

    writeFileSync(journalFile(paths), JSON.stringify({ version: 1, step: 'nowhere' }));
    expect(await readJournal(paths)).toBe('unreadable');
  });
});

describe('the roles a restore marked in its record', () => {
  const marked = {
    memberships: [],
    roleSettings: [],
    ownerPasswordHash: 'h',
    databaseFlags: {},
    databaseParameters: [],
    auditPrivileges: [],
  };

  it('are put back first, before the databases are looked at, and the mark goes only after that worked', async () => {
    await writeJournal(paths, { ...journal('restoring'), roles: marked });
    databases = [DATABASE, SCRATCH_DATABASE];
    let markWhenDatabasesWereRead: unknown = 'not read';
    const names = () => {
      calls.push('names');
      return Promise.resolve([...databases]);
    };

    await reconcileInterruptedRestore({
      paths,
      databases: {
        names: async () => {
          markWhenDatabasesWereRead = ((await readJournal(paths)) as RestoreJournal).roles;
          return names();
        },
        rename: () => Promise.resolve(),
        drop: (name) => {
          databases = databases.filter((candidate) => candidate !== name);
          return Promise.resolve();
        },
        dropRestoreRoles: () => Promise.resolve(),
      },
      revertRoles: (snapshot) => {
        calls.push('revert roles');
        revertedRoles.push(snapshot);
        return Promise.resolve();
      },
      reloadConfig: () => undefined,
    });

    expect(revertedRoles).toEqual([marked]);
    expect(calls.slice(0, 2)).toEqual(['revert roles', 'names']);
    expect(markWhenDatabasesWereRead).toBeNull();
  });

  it('keep the restore from going on when they cannot be put back: the mark stays for the next start', async () => {
    await writeJournal(paths, { ...journal('restoring'), roles: marked });
    revertRolesFails = true;

    await expect(reconcile()).rejects.toThrow('the server refused');

    expect(calls).toEqual(['revert roles']);
    expect(((await readJournal(paths)) as RestoreJournal).roles).toEqual(marked);
  });

  it('make the record unreadable when they are not of the shape of the roles, instead of failing on every start', async () => {
    writeFileSync(
      journalFile(paths),
      JSON.stringify({ ...journal('restoring'), roles: { memberships: 'none' } }),
    );

    expect(await readJournal(paths)).toBe('unreadable');
    expect(await reconcile()).toBe('unreadable');
    expect(calls).not.toContain('revert roles');
  });

  it('are asked for only when the record holds them', async () => {
    await writeJournal(paths, journal('restoring'));

    await reconcile();

    expect(calls).not.toContain('revert roles');
  });
});

describe('a restore that did not end', () => {
  it('does nothing when none was running, and removes the work files an interrupted one left', async () => {
    mkdirSync(join(paths.root, 'tmp-restore-9'), { recursive: true });
    mkdirSync(join(paths.root, 'tmp-backup-9'), { recursive: true });
    mkdirSync(paths.backups, { recursive: true });
    writeFileSync(join(paths.backups, 'consulvia-manual-2026-10-24_1000.cvb.partial'), 'half');
    writeFileSync(join(paths.backups, 'consulvia-manual-2026-10-24_1000.cvb'), 'whole');

    expect(await reconcile()).toBe('none');

    expect(existsSync(join(paths.root, 'tmp-restore-9'))).toBe(false);
    expect(existsSync(join(paths.root, 'tmp-backup-9'))).toBe(false);
    expect(existsSync(join(paths.backups, 'consulvia-manual-2026-10-24_1000.cvb.partial'))).toBe(
      false,
    );
    expect(existsSync(join(paths.backups, 'consulvia-manual-2026-10-24_1000.cvb'))).toBe(true);
  });

  it('drops the throwaway role of a restore at every start, whether a restore was pending or not', async () => {
    await reconcile();
    expect(roleDrops).toBe(1);

    filesHalfSwapped();
    databases = [DATABASE, SCRATCH_DATABASE];
    await writeJournal(paths, journal('restoring'));
    await reconcile();

    expect(roleDrops).toBe(2);
  });

  it('goes on, and says so, when a throwaway role cannot be dropped: it owns nothing and has no way in', async () => {
    roleDropFails = true;

    expect(await reconcile()).toBe('none');

    expect(logged.some((line) => line.includes('throwaway role'))).toBe(true);
  });

  it('drops the databases a restore left behind when no restore is pending', async () => {
    databases = [DATABASE, SCRATCH_DATABASE, ASIDE_DATABASE];

    await reconcile();

    expect(databases).toEqual([DATABASE]);
  });

  it('undoes it when it stopped before the databases traded places: documents back, scratch dropped', async () => {
    filesHalfSwapped();
    databases = [DATABASE, SCRATCH_DATABASE];
    await writeJournal(paths, journal('files-swapped'));

    expect(await reconcile()).toBe('rolled-back');

    expect(readFileSync(join(paths.files, 'old.obj'), 'utf8')).toBe('old');
    expect(existsSync(join(paths.files, 'from-the-backup.obj'))).toBe(false);
    expect(existsSync(aside())).toBe(false);
    expect(databases).toEqual([DATABASE]);
    expect(await readJournal(paths)).toBeNull();
    expect(existsSync(join(paths.root, 'tmp-restore-1'))).toBe(false);
    expect(reloads).toBe(0);
  });

  it('leaves the documents alone when it had not touched them yet', async () => {
    mkdirSync(paths.files, { recursive: true });
    writeFileSync(join(paths.files, 'current.obj'), 'current');
    databases = [DATABASE, SCRATCH_DATABASE];
    await writeJournal(paths, journal('restoring'));

    await reconcile();

    expect(readFileSync(join(paths.files, 'current.obj'), 'utf8')).toBe('current');
  });

  it('puts the old keys back when it had adopted the keys of the backup', async () => {
    filesHalfSwapped();
    databases = [DATABASE, SCRATCH_DATABASE];
    const copy = join(paths.root, 'config.json.pre-restore-1');
    writeFileSync(copy, 'the old configuration');
    writeFileSync(paths.configFile, 'the configuration with the keys of the backup');
    await writeJournal(paths, journal('secrets-adopted', copy));

    await reconcile();

    expect(readFileSync(paths.configFile, 'utf8')).toBe('the old configuration');
    expect(reloads).toBe(1);
    expect(existsSync(copy)).toBe(false);
  });

  it('puts a database name right when it stopped between the two renames', async () => {
    filesHalfSwapped();
    // `consultorio` was renamed aside and the scratch one had not taken its name yet.
    databases = [ASIDE_DATABASE, SCRATCH_DATABASE];
    await writeJournal(paths, journal('swapping'));

    expect(await reconcile()).toBe('rolled-back');

    expect(calls).toContain(`rename ${ASIDE_DATABASE} ${DATABASE}`);
    expect(databases).toEqual([DATABASE]);
    expect(readFileSync(join(paths.files, 'old.obj'), 'utf8')).toBe('old');
  });

  it('finishes it when the databases had traded places: the backup stays, the old documents go', async () => {
    filesHalfSwapped();
    // The scratch database is the product's now; the old one may still be waiting to be dropped.
    databases = [DATABASE, ASIDE_DATABASE];
    await writeJournal(paths, journal('swapping'));

    expect(await reconcile()).toBe('completed');

    expect(readFileSync(join(paths.files, 'from-the-backup.obj'), 'utf8')).toBe('backup');
    expect(existsSync(aside())).toBe(false);
    expect(databases).toEqual([DATABASE]);
    expect(await readJournal(paths)).toBeNull();
    expect(reloads).toBe(0);
  });

  it('puts the database of the product back under its name when that is the only one left and no restore is pending', async () => {
    databases = [ASIDE_DATABASE];

    await reconcile();

    expect(databases).toEqual([DATABASE]);
    expect(calls).toEqual([`rename ${ASIDE_DATABASE} ${DATABASE}`]);
  });

  it('keeps undoing after a first try dropped the scratch database and stopped, instead of taking it for a finished restore', async () => {
    filesHalfSwapped();
    // The first run decided to undo, wrote it down, dropped the scratch database and died.
    databases = [DATABASE];
    await writeJournal(paths, { ...journal('swapping'), undoing: true });

    expect(await reconcile()).toBe('rolled-back');

    expect(readFileSync(join(paths.files, 'old.obj'), 'utf8')).toBe('old');
    expect(existsSync(join(paths.files, 'from-the-backup.obj'))).toBe(false);
  });

  it('writes down that it is undoing before it undoes anything', async () => {
    filesHalfSwapped();
    databases = [DATABASE, SCRATCH_DATABASE];
    await writeJournal(paths, journal('swapping'));
    let seen: boolean | string | null = null;

    await reconcileInterruptedRestore({
      paths,
      databases: {
        names: () => Promise.resolve([...databases]),
        rename: () => Promise.resolve(),
        drop: async () => {
          const written = await readJournal(paths);
          seen = typeof written === 'object' && written !== null ? written.undoing : written;
          databases = [DATABASE];
        },
        dropRestoreRoles: () => Promise.resolve(),
      },
      reloadConfig: () => undefined,
    });

    expect(seen).toBe(true);
  });

  it('removes what the backup brought when there were no documents before', async () => {
    mkdirSync(paths.files, { recursive: true });
    writeFileSync(join(paths.files, 'from-the-backup.obj'), 'backup');
    databases = [DATABASE, SCRATCH_DATABASE];
    await writeJournal(paths, { ...journal('files-swapped'), hadFiles: false });

    await reconcile();

    expect(existsSync(paths.files)).toBe(false);
  });

  it('leaves the documents alone when they are already back and the copy aside is gone (a clean up that ran twice)', async () => {
    mkdirSync(paths.files, { recursive: true });
    writeFileSync(join(paths.files, 'old.obj'), 'old');
    databases = [DATABASE, SCRATCH_DATABASE];
    await writeJournal(paths, journal('files-swapped'));

    await reconcile();

    expect(readFileSync(join(paths.files, 'old.obj'), 'utf8')).toBe('old');
  });

  it('is not stopped by a copy of config.json that is already gone', async () => {
    filesHalfSwapped();
    databases = [DATABASE, SCRATCH_DATABASE];
    writeFileSync(paths.configFile, 'the configuration in place');
    await writeJournal(
      paths,
      journal('secrets-adopted', join(paths.root, 'config.json.pre-restore-1')),
    );

    expect(await reconcile()).toBe('rolled-back');

    expect(readFileSync(paths.configFile, 'utf8')).toBe('the configuration in place');
    expect(await readJournal(paths)).toBeNull();
  });

  it('leaves alone what "start over" set aside, whatever it was called before', async () => {
    const kept = [
      'files.replaced-5.aside-9',
      'config.json.pre-restore-5.aside-9',
      'tmp-restore-5.aside-9',
      'tmp-backup-5.aside-9',
    ];
    for (const name of kept) mkdirSync(join(paths.root, name), { recursive: true });

    await reconcile();

    for (const name of kept) expect(existsSync(join(paths.root, name)), name).toBe(true);
  });

  it('sweeps the copies of config.json and the old documents that no restore claims', async () => {
    writeFileSync(join(paths.root, 'config.json.pre-restore-5'), 'x');
    mkdirSync(`${paths.files}.replaced-5`, { recursive: true });

    await reconcile();

    expect(existsSync(join(paths.root, 'config.json.pre-restore-5'))).toBe(false);
    expect(existsSync(`${paths.files}.replaced-5`)).toBe(false);
  });

  it('reads a journal written before the documents were recorded as one that had documents', async () => {
    const { hadFiles, undoing, ...old } = journal('files-swapped');
    expect(hadFiles).toBe(true);
    expect(undoing).toBe(false);
    writeFileSync(journalFile(paths), JSON.stringify(old));

    expect(await readJournal(paths)).toMatchObject({ hadFiles: true, undoing: false });
  });

  it('touches nothing when the journal cannot be read', async () => {
    filesHalfSwapped();
    databases = [DATABASE, SCRATCH_DATABASE];
    writeFileSync(journalFile(paths), '{ broken');

    expect(await reconcile()).toBe('unreadable');

    expect(databases).toEqual([DATABASE, SCRATCH_DATABASE]);
    expect(existsSync(aside())).toBe(true);
    expect(existsSync(journalFile(paths))).toBe(true);
  });
});

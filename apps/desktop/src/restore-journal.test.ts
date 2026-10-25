import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'consulvia-journal-'));
  paths = testPaths(folder);
  mkdirSync(paths.root, { recursive: true });
  databases = [DATABASE];
  calls = [];
  reloads = 0;
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
    },
    reloadConfig: () => {
      reloads += 1;
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

  it('says so when the file is there but nobody can read it', async () => {
    writeFileSync(journalFile(paths), '{ not json');
    expect(await readJournal(paths)).toBe('unreadable');

    writeFileSync(journalFile(paths), JSON.stringify({ version: 1, step: 'nowhere' }));
    expect(await readJournal(paths)).toBe('unreadable');
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

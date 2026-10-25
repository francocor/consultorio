import { copyFile, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { BACKUP_EXTENSION } from './backup.js';
import type { DataPaths } from './paths.js';

/** The database of the product, the one a restore fills first, and the old one while the two trade places. */
export const DATABASE = 'consultorio';
export const SCRATCH_DATABASE = 'consultorio_restore';
export const ASIDE_DATABASE = 'consultorio_before_restore';

/**
 * Where a restore got to. It is written before the first thing that can be left half done and removed when
 * the restore is over, so that a power cut or a crash in the middle is found at the next start and either
 * finished or undone, instead of leaving two half-installs behind.
 *
 * In order: `prepared` (nothing touched yet), `restoring` (the scratch database exists), `files-swapped`
 * (the documents are the backup's), `secrets-adopted` (the keys are the backup's) and `swapping` (the
 * databases are trading places: after it, the backup's database is the real one).
 */
export type RestoreStep =
  'prepared' | 'restoring' | 'files-swapped' | 'secrets-adopted' | 'swapping';

export interface RestoreJournal {
  version: 1;
  stamp: string;
  step: RestoreStep;
  /** Where the old documents wait while the restored ones are in place. */
  filesAside: string;
  /** The work folder of the restore. */
  unpacked: string;
  /** A copy of `config.json` from before the keys of a backup were adopted, or null if there was none. */
  configCopy: string | null;
}

export const journalFile = (paths: DataPaths) => join(paths.root, 'restore-journal.json');

/** Writes the journal and forces it to the disk: it is what makes a crash recoverable. */
export async function writeJournal(paths: DataPaths, journal: RestoreJournal): Promise<void> {
  await mkdir(paths.root, { recursive: true });
  const target = journalFile(paths);
  const temporary = `${target}.tmp`;
  const handle = await open(temporary, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(journal)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
}

/** The journal, `null` when there is none, `'unreadable'` when there is a file nobody can make sense of. */
export async function readJournal(paths: DataPaths): Promise<RestoreJournal | null | 'unreadable'> {
  let text: string;
  try {
    text = await readFile(journalFile(paths), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'unreadable';
  }
  try {
    const value = JSON.parse(text) as Partial<RestoreJournal>;
    const steps: RestoreStep[] = [
      'prepared',
      'restoring',
      'files-swapped',
      'secrets-adopted',
      'swapping',
    ];
    if (
      value.version !== 1 ||
      typeof value.stamp !== 'string' ||
      !steps.includes(value.step as RestoreStep) ||
      typeof value.filesAside !== 'string' ||
      typeof value.unpacked !== 'string'
    ) {
      return 'unreadable';
    }
    return {
      version: 1,
      stamp: value.stamp,
      step: value.step as RestoreStep,
      filesAside: value.filesAside,
      unpacked: value.unpacked,
      configCopy: typeof value.configCopy === 'string' ? value.configCopy : null,
    };
  } catch {
    return 'unreadable';
  }
}

export async function clearJournal(paths: DataPaths): Promise<void> {
  await rm(journalFile(paths), { force: true });
}

/** Puts the copy of `config.json` that was taken before the keys changed back in its place. */
export async function restoreConfigCopy(paths: DataPaths, copy: string): Promise<void> {
  const temporary = `${paths.configFile}.restoring`;
  await copyFile(copy, temporary);
  await rename(temporary, paths.configFile);
}

export interface ReconcileDeps {
  paths: DataPaths;
  databases: {
    names: () => Promise<string[]>;
    rename: (from: string, to: string) => Promise<void>;
    drop: (name: string) => Promise<void>;
  };
  /** Reads the secrets again after `config.json` was put back. */
  reloadConfig: () => void;
  log?: (message: string) => void;
}

export type Reconciled = 'none' | 'rolled-back' | 'completed' | 'unreadable';

async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * At every start, before anything else uses the database: finishes or undoes a restore that did not end
 * (see `RestoreStep`), then clears what an interrupted backup or restore left lying around.
 *
 * - If the databases had already traded places (`swapping`, and the scratch database is gone), the restore is
 *   finished: the old documents and the work files are deleted.
 * - Otherwise it is undone: the old documents come back, the old keys come back, the scratch database is
 *   dropped, and a database name that was left half renamed is put right.
 */
export async function reconcileInterruptedRestore(deps: ReconcileDeps): Promise<Reconciled> {
  const { paths, databases, log } = deps;
  const journal = await readJournal(paths);
  if (journal === 'unreadable') {
    log?.('restore-journal.json cannot be read; leaving the data as it is');
    return 'unreadable';
  }
  let outcome: Reconciled = 'none';
  const names = await databases.names();
  if (journal !== null) {
    const swapped =
      journal.step === 'swapping' && !names.includes(SCRATCH_DATABASE) && names.includes(DATABASE);
    if (swapped) {
      await removeQuietly(journal.filesAside);
      if (names.includes(ASIDE_DATABASE)) await databases.drop(ASIDE_DATABASE);
      outcome = 'completed';
      log?.('an interrupted restore had reached the database: finished it');
    } else {
      // The database was not replaced: the old documents and the old keys are the right ones.
      if (!names.includes(DATABASE) && names.includes(ASIDE_DATABASE)) {
        await databases.rename(ASIDE_DATABASE, DATABASE);
      }
      if (names.includes(SCRATCH_DATABASE)) await databases.drop(SCRATCH_DATABASE);
      await rollBackFiles(paths, journal);
      if (journal.step === 'secrets-adopted' || journal.step === 'swapping') {
        if (journal.configCopy !== null) {
          await restoreConfigCopy(paths, journal.configCopy);
          deps.reloadConfig();
        }
      }
      outcome = 'rolled-back';
      log?.(`an interrupted restore was undone (it had reached "${journal.step}")`);
    }
    await removeQuietly(journal.unpacked);
    if (journal.configCopy !== null) await removeQuietly(journal.configCopy);
    await clearJournal(paths);
  } else {
    // No restore is pending: a database left from an earlier one is garbage.
    for (const leftover of [SCRATCH_DATABASE, ASIDE_DATABASE]) {
      if (names.includes(leftover)) await databases.drop(leftover);
    }
  }
  await sweepWorkFiles(paths);
  return outcome;
}

/** Puts the old documents back over the ones a restore had put in place. */
async function rollBackFiles(paths: DataPaths, journal: RestoreJournal): Promise<void> {
  // Nothing was moved aside until `files-swapped`: before it the folder in place is the real one.
  if (journal.step === 'prepared' || journal.step === 'restoring') return;
  let hasAside = true;
  try {
    await readdir(journal.filesAside);
  } catch {
    hasAside = false;
  }
  if (!hasAside) return;
  await removeQuietly(paths.files);
  await rename(journal.filesAside, paths.files);
}

/** Work files of a backup or a restore that did not finish; nothing is writing them at the start. */
async function sweepWorkFiles(paths: DataPaths): Promise<void> {
  for (const name of await readdir(paths.root).catch(() => [])) {
    if (/^tmp-(?:restore|backup)-/.test(name)) await removeQuietly(join(paths.root, name));
  }
  for (const name of await readdir(paths.backups).catch(() => [])) {
    if (name.endsWith(`${BACKUP_EXTENSION}.partial`))
      await removeQuietly(join(paths.backups, name));
  }
}

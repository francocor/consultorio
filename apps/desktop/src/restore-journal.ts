import { copyFile, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { renameWithRetry } from './backup-archive.js';
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
 * In order: `prepared` (nothing touched yet), `restoring` (the scratch database exists), `files-swapping` (the
 * documents are being moved: from here the folder in place may be the old one, none, or the backup's),
 * `files-swapped` (the documents are the backup's), `secrets-adopted` (the keys are the backup's) and `swapping`
 * (the databases are trading places: after it, the backup's database is the real one).
 */
export type RestoreStep =
  'prepared' | 'restoring' | 'files-swapping' | 'files-swapped' | 'secrets-adopted' | 'swapping';

const STEPS: readonly RestoreStep[] = [
  'prepared',
  'restoring',
  'files-swapping',
  'files-swapped',
  'secrets-adopted',
  'swapping',
];

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
  /** Whether the documents folder existed when the restore began: what to put back is decided from it. */
  hadFiles: boolean;
  /**
   * Set (and forced to the disk) before anything is undone. Whether the databases traded places is read from the
   * cluster, and undoing drops the scratch database, which is the very fact that tells the two cases apart: once
   * the decision to undo is taken it is written down, and a start that finds it undoes again, whatever the cluster
   * looks like by then.
   */
  undoing: boolean;
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
  await renameWithRetry(temporary, target);
}

const UNREADABLE = Symbol('unreadable');
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);
/** An antivirus or an indexer that holds the file lets go within seconds: it is waited for about ten. */
const READ_ATTEMPTS = 40;
const READ_WAIT_MS = 250;

/** Reads the journal file, trying again a few times when something (an antivirus) holds it for a moment. */
async function readJournalText(paths: DataPaths): Promise<string | null | typeof UNREADABLE> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readFile(journalFile(paths), 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return null;
      if (!BUSY.has(code) || attempt >= READ_ATTEMPTS) return UNREADABLE;
      await new Promise((resolve) => setTimeout(resolve, READ_WAIT_MS));
    }
  }
}

/** The journal, `null` when there is none, `'unreadable'` when there is a file nobody can make sense of. */
export async function readJournal(paths: DataPaths): Promise<RestoreJournal | null | 'unreadable'> {
  const text = await readJournalText(paths);
  if (text === null) return null;
  if (text === UNREADABLE) return 'unreadable';
  try {
    const value = JSON.parse(text) as Partial<RestoreJournal>;
    if (
      value.version !== 1 ||
      typeof value.stamp !== 'string' ||
      !STEPS.includes(value.step as RestoreStep) ||
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
      // A journal written before this field existed: the safe reading is that there were documents.
      hadFiles: value.hadFiles !== false,
      undoing: value.undoing === true,
    };
  } catch {
    return 'unreadable';
  }
}

export async function clearJournal(paths: DataPaths): Promise<void> {
  await rm(journalFile(paths), { force: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Puts the copy of `config.json` that was taken before the keys changed back in its place. */
export async function restoreConfigCopy(paths: DataPaths, copy: string): Promise<void> {
  // A copy that is gone was put back by an earlier run that stopped before it could say so.
  if (!(await exists(copy))) return;
  const temporary = `${paths.configFile}.restoring`;
  await copyFile(copy, temporary);
  await renameWithRetry(temporary, paths.configFile);
}

export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Puts the documents of before the restore back, deciding from what is on the disk and not from the step alone
 * (a crash between the two renames leaves the folder in place missing, empty or the backup's, and the old one
 * aside). Safe to run again: what is already back is left alone.
 *
 * - The old documents are aside: whatever is in place goes, and they come back.
 * - Nothing is aside, and there were documents before: they are already back, or were never moved.
 * - Nothing is aside, and there were none before: what is in place came from the backup and goes.
 */
export async function rollBackFiles(paths: DataPaths, journal: RestoreJournal): Promise<void> {
  // Nothing was moved until `files-swapping`.
  if (journal.step === 'prepared' || journal.step === 'restoring') return;
  if (await exists(journal.filesAside)) {
    await rm(paths.files, { recursive: true, force: true });
    await renameWithRetry(journal.filesAside, paths.files);
    return;
  }
  if (!journal.hadFiles) await rm(paths.files, { recursive: true, force: true });
}

export interface ReconcileDeps {
  paths: DataPaths;
  databases: {
    names: () => Promise<string[]>;
    rename: (from: string, to: string) => Promise<void>;
    drop: (name: string) => Promise<void>;
    /** Drops the throwaway role of every restore (its database is gone by now): a restore cut off leaves one behind. */
    dropRestoreRoles: () => Promise<void>;
  };
  /** Reads the secrets again after `config.json` was put back. */
  reloadConfig: () => void;
  log?: (message: string) => void;
  /** Clear the work files of backups and restores too (at the start, when nothing else is running). Default true. */
  sweep?: boolean;
}

export type Reconciled = 'none' | 'rolled-back' | 'completed' | 'unreadable';

/**
 * At every start, before anything else uses the database or the documents: finishes or undoes a restore that did
 * not end (see `RestoreStep`), then clears what an interrupted backup or restore left lying around.
 *
 * - If the databases had already traded places (`swapping`, and the scratch database is gone), the restore is
 *   finished: the old documents and the work files are deleted.
 * - Otherwise it is undone: the old documents come back, the old keys come back, the scratch database is
 *   dropped, and a database name that was left half renamed is put right.
 *
 * It can itself be cut off at any point and run again: every step looks at what is there, and the journal is
 * removed as soon as the data is right, before the copies are deleted, so what is left behind is only garbage
 * that the sweep removes.
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
      !journal.undoing &&
      journal.step === 'swapping' &&
      !names.includes(SCRATCH_DATABASE) &&
      names.includes(DATABASE);
    if (swapped) {
      if (names.includes(ASIDE_DATABASE)) await databases.drop(ASIDE_DATABASE);
      outcome = 'completed';
      log?.('an interrupted restore had reached the database: finished it');
    } else {
      // The database was not replaced: the old documents and the old keys are the right ones. This is written
      // down first, because the steps below destroy what told this case from the other.
      if (!journal.undoing) {
        journal.undoing = true;
        await writeJournal(paths, journal);
      }
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
    // The data is right. The journal goes first: a crash after this leaves garbage, not a boot that fails.
    await clearJournal(paths);
    if (outcome === 'completed') await removeQuietly(journal.filesAside);
    await removeQuietly(journal.unpacked);
    if (journal.configCopy !== null) await removeQuietly(journal.configCopy);
  } else {
    // No restore is pending: a database left from an earlier one is garbage, unless it is the only one the
    // product has (a rename that was cut off): that one goes back to its name.
    if (!names.includes(DATABASE) && names.includes(ASIDE_DATABASE)) {
      await databases.rename(ASIDE_DATABASE, DATABASE);
      log?.('the database of the product was found under its safety name and put back');
    } else if (names.includes(ASIDE_DATABASE)) {
      await databases.drop(ASIDE_DATABASE);
    }
    if (names.includes(SCRATCH_DATABASE)) await databases.drop(SCRATCH_DATABASE);
  }
  // The role a restore ran its dump as: it owns nothing once its database is gone, and it is never needed again.
  try {
    await databases.dropRestoreRoles();
  } catch (error) {
    log?.(
      `a throwaway role of a restore could not be dropped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (deps.sweep !== false) await sweepWorkFiles(paths);
  return outcome;
}

/**
 * The names of the work files of a backup or a restore: followed by the time they were made, and nothing else, so
 * that what "start over" set aside (`.aside-<stamp>` after the name) is never taken for one.
 */
export const RESTORE_WORK_FILES =
  /^(?:tmp-(?:restore|backup)-\d+|config\.json\.pre-restore-\d+|files\.replaced-\d+)$/;

/** Work files of a backup or a restore that did not finish; nothing is writing them at the start. */
async function sweepWorkFiles(paths: DataPaths): Promise<void> {
  for (const name of await readdir(paths.root).catch(() => [])) {
    if (RESTORE_WORK_FILES.test(name) || name === 'config.json.restoring') {
      await removeQuietly(join(paths.root, name));
    }
  }
  for (const name of await readdir(paths.backups).catch(() => [])) {
    if (name.endsWith(`${BACKUP_EXTENSION}.partial`))
      await removeQuietly(join(paths.backups, name));
  }
}

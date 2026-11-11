import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { renameWithRetry } from './backup-archive.js';

/**
 * The backups that were opened again after they were written, and found whole: a file in the backups folder
 * is not counted as a good copy until it is in here. Pruning deletes only these, so a corrupt or half-written
 * file can never push a good copy out. The ledger sits beside the backups, so it travels with them.
 */
export const LEDGER_NAME = 'registro-de-copias.json';

export interface LedgerEntry {
  /** SHA-256 of the whole file. */
  sha256: string;
  bytes: number;
  verifiedAt: string;
}

export type Ledger = Record<string, LedgerEntry>;

export async function readLedger(directory: string): Promise<Ledger> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, LEDGER_NAME), 'utf8')) as {
      files?: unknown;
    };
    const files = parsed.files;
    return typeof files === 'object' && files !== null && !Array.isArray(files)
      ? (files as Ledger)
      : {};
  } catch {
    // Missing or unreadable: nothing is verified, so nothing gets pruned. That is the safe direction.
    return {};
  }
}

/**
 * The writes of the ledger take turns: a read-change-write that overlaps another one (a backup recording itself while
 * the backups found at the start are being entered) would lose the entry of one of them.
 */
let turn: Promise<unknown> = Promise.resolve();
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const next = turn.then(work, work);
  turn = next.catch(() => undefined);
  return next;
}

async function writeJsonDurably(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Written to a temporary file, forced to the disk, and renamed: a power cut leaves the old ledger or the new one. */
async function writeLedger(directory: string, files: Ledger): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, LEDGER_NAME);
  const temporary = `${target}.tmp`;
  try {
    await writeJsonDurably(temporary, { version: 1, files });
    await renameWithRetry(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function recordVerified(
  directory: string,
  name: string,
  entry: LedgerEntry,
): Promise<void> {
  await inTurn(async () => {
    const files = await readLedger(directory);
    files[name] = entry;
    await writeLedger(directory, files);
  });
}

/** Drops the entries of files that are gone (or were deleted). */
export async function forgetBackups(directory: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  await inTurn(async () => {
    const files = await readLedger(directory);
    let changed = false;
    for (const name of names) {
      if (name in files) {
        Reflect.deleteProperty(files, name);
        changed = true;
      }
    }
    if (changed) await writeLedger(directory, files);
  });
}

/**
 * Backups that were looked at and not entered in the ledger (they do not authenticate, or were made with another
 * key), with the size they had: a file is not read again at every start while it is the same file. The ledger says
 * what is vouched for; this says what is not worth opening again.
 */
export const REJECTED_NAME = 'registro-de-copias-rechazadas.json';

/** How long a file stays rejected. After that it is looked at again: whatever was wrong with it may be gone. */
export const REJECTED_FOR_MS = 7 * 24 * 3_600_000;

interface RejectedEntry {
  bytes: number;
  /** When it was rejected, in milliseconds. */
  at: number;
}

/** The entries of the list, with the ones of an earlier version (a size alone) as already expired. */
async function readRejectedEntries(directory: string): Promise<Record<string, RejectedEntry>> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, REJECTED_NAME), 'utf8')) as {
      files?: unknown;
    };
    const files = parsed.files;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return {};
    const entries: Record<string, RejectedEntry> = {};
    for (const [name, value] of Object.entries(files)) {
      if (typeof value === 'number') {
        entries[name] = { bytes: value, at: 0 };
      } else if (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as RejectedEntry).bytes === 'number' &&
        typeof (value as RejectedEntry).at === 'number'
      ) {
        entries[name] = { bytes: (value as RejectedEntry).bytes, at: (value as RejectedEntry).at };
      }
    }
    return entries;
  } catch {
    return {};
  }
}

/** The files that are rejected now, with the size they had: the ones rejected less than a week ago. */
export async function readRejected(
  directory: string,
  now: Date = new Date(),
): Promise<Record<string, number>> {
  const entries = await readRejectedEntries(directory);
  return Object.fromEntries(
    Object.entries(entries)
      .filter(([, entry]) => now.getTime() - entry.at < REJECTED_FOR_MS)
      .map(([name, entry]) => [name, entry.bytes]),
  );
}

export async function rememberRejected(
  directory: string,
  name: string,
  bytes: number,
  now: Date = new Date(),
): Promise<void> {
  await inTurn(async () => {
    const files = Object.fromEntries(
      Object.entries(await readRejectedEntries(directory)).filter(
        ([, entry]) => now.getTime() - entry.at < REJECTED_FOR_MS,
      ),
    );
    files[name] = { bytes, at: now.getTime() };
    await mkdir(directory, { recursive: true });
    const target = join(directory, REJECTED_NAME);
    const temporary = `${target}.tmp`;
    try {
      await writeJsonDurably(temporary, { version: 2, files });
      await renameWithRetry(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
}

/** SHA-256 of a file, read in pieces. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

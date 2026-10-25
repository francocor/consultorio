import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

async function writeLedger(directory: string, files: Ledger): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = join(directory, LEDGER_NAME);
  const temporary = `${target}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
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
  const files = await readLedger(directory);
  files[name] = entry;
  await writeLedger(directory, files);
}

/** Drops the entries of files that are gone (or were deleted). */
export async function forgetBackups(directory: string, names: readonly string[]): Promise<void> {
  if (names.length === 0) return;
  const files = await readLedger(directory);
  let changed = false;
  for (const name of names) {
    if (name in files) {
      Reflect.deleteProperty(files, name);
      changed = true;
    }
  }
  if (changed) await writeLedger(directory, files);
}

/** SHA-256 of a file, read in pieces. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

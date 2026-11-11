import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { generateInScratch } from './drizzle-scratch.js';
import {
  formatPrefix,
  prefixOf,
  readFolder,
  restampJournal,
  writeJournal,
} from './migration-journal.js';

export interface RestampReport {
  /** Entries whose stamp was raised. */
  restamped: string[];
  /** Snapshots (by number) whose parent was changed to the snapshot before them. */
  relinked: string[];
  /** True when `idx` was renumbered. */
  renumbered: boolean;
  /** Set only when the last snapshot was rebuilt from the schema (`--refresh`). */
  refreshedSnapshot?: boolean;
}

const ZERO_ID = '00000000-0000-0000-0000-000000000000';

export interface RestampOptions {
  /** Rebuild the last snapshot from the Drizzle schema, so it describes every merged track. */
  refresh?: { schemaFile: string; scratchDir: string };
}

async function writeSnapshot(path: string, snapshot: Record<string, unknown>, raw: string) {
  const trailing = raw.endsWith('\n') ? '\n' : '';
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}${trailing}`);
}

/**
 * Makes the folder consistent after a merge or a rebase put migrations of different tracks side by
 * side:
 *
 * 1. `idx` is numbered again and every stamp that does not rise is raised (the frozen sequence is
 *    never touched), in the order the journal lists the entries, which is the merge order;
 * 2. each snapshot is chained to the one before it in that order (two tracks that branched from the
 *    same snapshot each continued it, and drizzle-kit refuses two children of one parent);
 * 3. with `refresh`, the last snapshot is rebuilt from the schema, because it is the one
 *    drizzle-kit compares the schema with and it knew only its own track's tables.
 *
 * It changes nothing when nothing needs it, so running it twice is the same as once.
 */
export async function restampFolder(
  migrationsDir: string,
  options: RestampOptions = {},
): Promise<RestampReport> {
  const state = await readFolder(migrationsDir);
  const restamped = restampJournal(state.journal);

  const changedStamps = restamped.entries
    .filter((entry, i) => entry.when !== state.journal.entries[i]?.when)
    .map((entry) => entry.tag);
  const renumbered = restamped.entries.some(
    (entry, i) => entry.idx !== state.journal.entries[i]?.idx,
  );
  if (changedStamps.length > 0 || renumbered) await writeJournal(migrationsDir, restamped);

  const relinked: string[] = [];
  let parentId = ZERO_ID;
  for (const [position, entry] of restamped.entries.entries()) {
    const prefix = prefixOf(entry.tag);
    if (prefix === null) continue;
    const path = join(migrationsDir, 'meta', `${formatPrefix(prefix)}_snapshot.json`);
    const raw = await readFile(path, 'utf8');
    const snapshot = JSON.parse(raw) as Record<string, unknown> & { id: string; prevId: string };
    if (position > 0 && snapshot.prevId !== parentId) {
      await writeSnapshot(path, { ...snapshot, prevId: parentId }, raw);
      relinked.push(formatPrefix(prefix));
    }
    parentId = snapshot.id;
  }

  const report: RestampReport = { restamped: changedStamps, relinked, renumbered };
  if (options.refresh) {
    report.refreshedSnapshot = await refreshLastSnapshot(migrationsDir, options.refresh);
  }
  return report;
}

/** Rebuilds the last snapshot from the schema, keeping its id and its parent. */
async function refreshLastSnapshot(
  migrationsDir: string,
  refresh: NonNullable<RestampOptions['refresh']>,
): Promise<boolean> {
  const { journal } = await readFolder(migrationsDir);
  const last = journal.entries.at(-1);
  const lastPrefix = last ? prefixOf(last.tag) : null;
  if (!last || lastPrefix === null) return false;
  const path = join(migrationsDir, 'meta', `${formatPrefix(lastPrefix)}_snapshot.json`);
  const raw = await readFile(path, 'utf8');
  const current = JSON.parse(raw) as Record<string, unknown> & { id: string; prevId: string };

  const generated = await generateInScratch({
    schemaFile: refresh.schemaFile,
    migrationsDir,
    scratchDir: refresh.scratchDir,
    dropLast: true,
  });
  // Nothing written means the snapshot before the last one already is the schema.
  const penultimate = journal.entries.at(-2);
  const penultimatePrefix = penultimate ? prefixOf(penultimate.tag) : null;
  const schemaSnapshot =
    generated.snapshot ??
    (penultimatePrefix === null
      ? null
      : (JSON.parse(
          await readFile(
            join(migrationsDir, 'meta', `${formatPrefix(penultimatePrefix)}_snapshot.json`),
            'utf8',
          ),
        ) as Record<string, unknown>));
  if (!schemaSnapshot) return false;

  const next = { ...schemaSnapshot, id: current.id, prevId: current.prevId };
  // The order of the keys is drizzle-kit's business; only a different schema counts as a change.
  if (isDeepStrictEqual(next, current)) return false;
  await writeSnapshot(path, next, raw);
  return true;
}

/** pnpm db:restamp [--no-refresh] */
async function main(): Promise<void> {
  const apiRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const migrationsDir = join(apiRoot, 'src/db/migrations');
  const refresh = !process.argv.includes('--no-refresh');
  const report = await restampFolder(migrationsDir, {
    ...(refresh
      ? {
          refresh: {
            schemaFile: join(apiRoot, 'src/db/schema/index.ts'),
            scratchDir: join(apiRoot, 'node_modules/.cache/migration-restamp'),
          },
        }
      : {}),
  });
  process.stdout.write(
    [
      report.restamped.length > 0
        ? `Stamps raised: ${report.restamped.join(', ')}`
        : 'Stamps: already rising.',
      report.relinked.length > 0
        ? `Snapshots re-chained: ${report.relinked.join(', ')}`
        : 'Snapshots: already chained.',
      refresh
        ? report.refreshedSnapshot
          ? 'The last snapshot was rebuilt from the schema.'
          : 'The last snapshot already matches the schema.'
        : 'The last snapshot was not rebuilt (--no-refresh).',
      'Next: pnpm db:check',
    ].join('\n') + '\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'db:restamp failed'}\n`);
    process.exit(1);
  });
}

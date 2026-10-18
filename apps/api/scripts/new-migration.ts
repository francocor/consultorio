import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateInScratch } from './drizzle-scratch.js';
import {
  TRACK_RANGES,
  formatPrefix,
  prefixOf,
  readFolder,
  writeJournal,
  type Journal,
} from './migration-journal.js';

const NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The number for the next migration of a track: the one a task names (`--number`), when it is
 * inside the range and free, otherwise the first free number after the highest the track used.
 */
export function nextMigrationNumber(journal: Journal, track: string, requested?: number): number {
  const range = TRACK_RANGES[track];
  if (!range) {
    throw new Error(`Unknown track "${track}". Tracks: ${Object.keys(TRACK_RANGES).join(', ')}.`);
  }
  const used = new Set(
    journal.entries.map((entry) => prefixOf(entry.tag)).filter((prefix) => prefix !== null),
  );
  if (requested !== undefined) {
    if (requested < range.start || requested > range.end) {
      throw new Error(
        `${formatPrefix(requested)} is outside the range of track ${track} (${formatPrefix(range.start)} to ${formatPrefix(range.end)}).`,
      );
    }
    if (used.has(requested)) throw new Error(`${formatPrefix(requested)} is already used.`);
    return requested;
  }
  const inRange = [...used].filter((prefix) => prefix >= range.start && prefix <= range.end);
  const next = inRange.length === 0 ? range.start : Math.max(...inRange) + 1;
  if (next > range.end) {
    throw new Error(
      `The range of track ${track} (${formatPrefix(range.start)} to ${formatPrefix(range.end)}) is full.`,
    );
  }
  return next;
}

export interface CreateMigrationOptions {
  migrationsDir: string;
  track: string;
  /** Lowercase words joined by underscores. */
  name: string;
  /** The clock, for the stamp. Defaults to now. */
  now?: Date;
  /** A number the task names; otherwise the next free one of the track. */
  number?: number;
  /** The SQL of the migration. Defaults to an empty custom migration to fill in. */
  sql?: string;
  /** The snapshot of the schema after the migration. Defaults to a copy of the last snapshot. */
  snapshot?: Record<string, unknown>;
}

export interface CreatedMigration {
  tag: string;
  sqlFile: string;
}

/**
 * Creates a migration in the range of a track: the `.sql` file, the snapshot that continues the
 * last one of the journal, and the journal entry, stamped later than every entry already there
 * (the migrator would skip an older stamp on a database that ran the entries before it).
 */
export async function createMigration(options: CreateMigrationOptions): Promise<CreatedMigration> {
  if (!NAME.test(options.name)) {
    throw new Error(
      `The name "${options.name}" must be lowercase words joined by underscores (letters, digits, "_").`,
    );
  }
  const state = await readFolder(options.migrationsDir);
  const number = nextMigrationNumber(state.journal, options.track, options.number);
  const prefix = formatPrefix(number);
  const tag = `${prefix}_${options.name}`;
  const range = TRACK_RANGES[options.track];

  const lastWhen = Math.max(0, ...state.journal.entries.map((entry) => entry.when));
  const when = Math.max((options.now ?? new Date()).getTime(), lastWhen + 1);

  const lastEntry = state.journal.entries.at(-1);
  const lastPrefix = lastEntry ? prefixOf(lastEntry.tag) : null;
  const lastSnapshot =
    lastPrefix === null ? undefined : state.snapshots.get(formatPrefix(lastPrefix));
  const parentId = lastSnapshot?.id ?? '00000000-0000-0000-0000-000000000000';
  const base =
    options.snapshot ??
    (lastPrefix === null
      ? { version: '7', dialect: 'postgresql', tables: {} }
      : (JSON.parse(
          await readFile(
            join(options.migrationsDir, 'meta', `${formatPrefix(lastPrefix)}_snapshot.json`),
            'utf8',
          ),
        ) as Record<string, unknown>));
  const snapshot = { ...base, id: randomUUID(), prevId: parentId };

  const sql =
    options.sql ??
    `-- Custom SQL migration file, put your code below! --\n-- ${range?.label ?? options.track}: ${options.name}\n`;
  await writeFile(join(options.migrationsDir, `${tag}.sql`), sql);
  await writeFile(
    join(options.migrationsDir, 'meta', `${prefix}_snapshot.json`),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  await writeJournal(options.migrationsDir, {
    ...state.journal,
    entries: [
      ...state.journal.entries,
      {
        idx: state.journal.entries.length,
        version: '7',
        when,
        tag,
        breakpoints: true,
      },
    ],
  });
  return { tag, sqlFile: `${tag}.sql` };
}

function parseArguments(argv: readonly string[]) {
  const positional: string[] = [];
  let number: number | undefined;
  let custom = false;
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i] ?? '';
    if (argument === '--custom') custom = true;
    else if (argument === '--number') number = Number(argv[(i += 1)]);
    else positional.push(argument);
  }
  const [track, name] = positional;
  if (!track || !name || (number !== undefined && !Number.isInteger(number))) {
    throw new Error('Usage: pnpm db:new <track> <name> [--number NNNN] [--custom]');
  }
  return { track, name, number, custom };
}

/**
 * pnpm db:new <track> <name> [--number NNNN] [--custom]
 *
 * Creates the next migration of a track (the ranges are in docs/migration-ranges.md). When the
 * Drizzle schema has changes no migration covers, the migration carries the SQL drizzle-kit writes
 * for them; otherwise (or with --custom) it is an empty file for hand-written SQL.
 */
async function main(): Promise<void> {
  const { track, name, number, custom } = parseArguments(process.argv.slice(2));
  const apiRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const migrationsDir = join(apiRoot, 'src/db/migrations');

  const generated = custom
    ? null
    : await generateInScratch({
        schemaFile: join(apiRoot, 'src/db/schema/index.ts'),
        migrationsDir,
        scratchDir: join(apiRoot, 'node_modules/.cache/migration-new'),
        name,
      });
  const created = await createMigration({
    migrationsDir,
    track,
    name,
    ...(number === undefined ? {} : { number }),
    ...(generated?.sql ? { sql: generated.sql.content } : {}),
    ...(generated?.snapshot ? { snapshot: generated.snapshot } : {}),
  });
  process.stdout.write(
    `Created ${created.sqlFile}${generated?.sql ? ' from the schema changes' : ' (empty, for hand-written SQL)'}.\n` +
      (generated?.sql
        ? 'For new tenant tables run: pnpm --filter @consultorio/api exec tsx scripts/finish-migration.ts <file> <table>...\n'
        : ''),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'db:new failed'}\n`);
    process.exit(1);
  });
}

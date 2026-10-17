import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkMigrationDrift } from './check-migration-drift.js';
import { generateInScratch } from './drizzle-scratch.js';
import { readFolder, writeJournal } from './migration-journal.js';
import { createMigration } from './new-migration.js';
import { restampFolder } from './restamp-migrations.js';

const apiRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const migrationsDir = join(apiRoot, 'src/db/migrations');
const realSchema = join(apiRoot, 'src/db/schema/index.ts').replaceAll('\\', '/');
// Inside the package so that the scratch schema can import drizzle-orm.
const scratchDir = join(apiRoot, 'node_modules/.cache/migration-drift-test');

let workDir: string;

beforeAll(async () => {
  await mkdir(scratchDir, { recursive: true });
  workDir = await mkdtemp(join(scratchDir, 'schema-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A schema file: everything committed, plus one table per name. */
async function schemaWith(file: string, ...tables: string[]): Promise<string> {
  const path = join(workDir, file);
  await writeFile(
    path,
    [
      "import { pgTable, uuid } from 'drizzle-orm/pg-core';",
      '',
      `export * from '${realSchema}';`,
      ...tables.map(
        (table) => `export const ${table} = pgTable('${table}', { id: uuid('id').primaryKey() });`,
      ),
      '',
    ].join('\n'),
  );
  return path;
}

/** A copy of the committed migrations that a test may edit. */
async function copyOfMigrations(): Promise<string> {
  const dir = await mkdtemp(join(workDir, 'copy-'));
  await cp(migrationsDir, dir, { recursive: true });
  return dir;
}

describe('checkMigrationDrift', () => {
  it('passes on the committed schema and migrations', async () => {
    const result = await checkMigrationDrift({
      schemaFile: join(apiRoot, 'src/db/schema/index.ts'),
      migrationsDir,
      scratchDir,
    });

    expect(result.missing).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.drift).toBe(false);
  }, 60_000);

  it('fails when the schema gains a table that has no migration', async () => {
    const schemaFile = await schemaWith('edited-schema.ts', 'hand_edited');

    const result = await checkMigrationDrift({ schemaFile, migrationsDir, scratchDir });

    expect(result.drift).toBe(true);
    expect(result.missing).toHaveLength(1);
  }, 60_000);

  it('fails on a journal whose stamps do not rise, without comparing the schema', async () => {
    const dir = await copyOfMigrations();
    const { journal } = await readFolder(dir);
    const last = journal.entries.at(-1);
    if (!last) throw new Error('the committed journal is empty');
    // The shape a rebase leaves: the last entry is older than the one before it.
    last.when = (journal.entries.at(-2)?.when ?? 0) - 1;
    await writeJournal(dir, journal);

    const result = await checkMigrationDrift({
      schemaFile: join(apiRoot, 'src/db/schema/index.ts'),
      migrationsDir: dir,
      scratchDir,
    });

    expect(result.problems.map((problem) => problem.code)).toEqual(['non_monotonic_when']);
    expect(result.problems[0]?.tag).toBe(last.tag);
    expect(result.drift).toBe(false);
  }, 60_000);
});

describe('db:restamp on a folder that is already right', () => {
  it('changes nothing in the committed migrations, not even the order of the keys of a snapshot', async () => {
    const dir = await copyOfMigrations();
    const before = await readFile(join(dir, 'meta', '0035_snapshot.json'), 'utf8');
    const journalBefore = await readFile(join(dir, 'meta', '_journal.json'), 'utf8');

    const report = await restampFolder(dir, {
      refresh: { schemaFile: join(apiRoot, 'src/db/schema/index.ts'), scratchDir },
    });

    expect(report).toEqual({
      restamped: [],
      relinked: [],
      renumbered: false,
      refreshedSnapshot: false,
    });
    expect(await readFile(join(dir, 'meta', '0035_snapshot.json'), 'utf8')).toBe(before);
    expect(await readFile(join(dir, 'meta', '_journal.json'), 'utf8')).toBe(journalBefore);
  }, 60_000);
});

describe('the migration tools together (two tracks, one merge)', () => {
  it('creates a migration in a track range, and after a merge db:restamp makes the folder pass again', async () => {
    const stamp = (await readFolder(migrationsDir)).journal.entries.at(-1)?.when ?? 0;
    const schemaA = await schemaWith('track-a.ts', 'track_a_table');
    const schemaB = await schemaWith('track-b.ts', 'track_b_table');
    const merged = await schemaWith('merged.ts', 'track_a_table', 'track_b_table');

    // Two Stage 4 tracks play the parts: no track of Stage 3 has a number to itself in this test,
    // so a real migration of Stage 3 (messaging has some) never changes what it expects.
    // Track A creates its migration from its schema, on its copy of the folder.
    const a = await copyOfMigrations();
    const generatedA = await generateInScratch({
      schemaFile: schemaA,
      migrationsDir: a,
      scratchDir,
      name: 'track_a_table',
    });
    await createMigration({
      migrationsDir: a,
      track: '4a',
      name: 'track_a_table',
      now: new Date(stamp + 5_000),
      ...(generatedA.sql ? { sql: generatedA.sql.content } : {}),
      ...(generatedA.snapshot ? { snapshot: generatedA.snapshot } : {}),
    });
    expect(
      (await checkMigrationDrift({ schemaFile: schemaA, migrationsDir: a, scratchDir })).drift,
    ).toBe(false);
    expect(await readFile(join(a, '0410_track_a_table.sql'), 'utf8')).toContain('"track_a_table"');

    // Track B does the same, at the same time, from the same base.
    const b = await copyOfMigrations();
    const generatedB = await generateInScratch({
      schemaFile: schemaB,
      migrationsDir: b,
      scratchDir,
      name: 'track_b_table',
    });
    await createMigration({
      migrationsDir: b,
      track: '4b',
      name: 'track_b_table',
      now: new Date(stamp + 2_000),
      ...(generatedB.sql ? { sql: generatedB.sql.content } : {}),
      ...(generatedB.snapshot ? { snapshot: generatedB.snapshot } : {}),
    });

    // The merge: B's files and journal entry land after A's.
    await cp(join(b, '0430_track_b_table.sql'), join(a, '0430_track_b_table.sql'));
    await cp(join(b, 'meta', '0430_snapshot.json'), join(a, 'meta', '0430_snapshot.json'));
    const mergedJournal = (await readFolder(a)).journal;
    const entryB = (await readFolder(b)).journal.entries.at(-1);
    if (!entryB) throw new Error('track B has no entry');
    mergedJournal.entries.push({ ...entryB, idx: mergedJournal.entries.length });
    await writeJournal(a, mergedJournal);

    const before = await checkMigrationDrift({ schemaFile: merged, migrationsDir: a, scratchDir });
    expect(before.problems.map((problem) => problem.code).sort()).toEqual([
      'broken_snapshot_chain',
      'non_monotonic_when',
    ]);

    const report = await restampFolder(a, { refresh: { schemaFile: merged, scratchDir } });

    expect(report.restamped).toEqual(['0430_track_b_table']);
    expect(report.relinked).toEqual(['0430']);
    expect(report.refreshedSnapshot).toBe(true);
    const after = await checkMigrationDrift({ schemaFile: merged, migrationsDir: a, scratchDir });
    expect(after.problems).toEqual([]);
    expect(after.missing).toEqual([]);
    expect(after.drift).toBe(false);
  }, 180_000);
});

import { rm } from 'node:fs/promises';

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { makeMigrationsFolder } from '../../scripts/migration-folder.js';
import { checkJournalFolder, readFolder, writeJournal } from '../../scripts/migration-journal.js';
import { restampFolder } from '../../scripts/restamp-migrations.js';
import { createOwnerDb, type DbHandle } from '../../src/platform/db/pool.js';

/**
 * Why the migration ranges are safe, and why the stamps must rise, shown against a real Postgres.
 * Drizzle's migrator ignores the number in a tag: it applies, in journal order, the entries whose
 * `when` is later than the newest one the database ran. A throwaway database keeps this away from
 * the schema every other test shares.
 */
const DATABASE = 'migration_lanes_probe';

let owner: DbHandle;
const folders: string[] = [];

function probeUrl(): string {
  const url = new URL(inject('ownerUrl'));
  url.pathname = `/${DATABASE}`;
  return url.toString();
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.query(`CREATE DATABASE ${DATABASE} OWNER app_owner`);
  } finally {
    await admin.end();
  }
  owner = createOwnerDb(probeUrl());
}, 60_000);

afterAll(async () => {
  await owner.close();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

async function tables(): Promise<string[]> {
  const result = await owner.db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
  );
  return result.rows.map((row) => row.table_name);
}

describe('migration lanes on a real database', () => {
  it('applies migrations whose numbers jump between ranges, in journal order, and skips an older stamp', async () => {
    const dir = await makeMigrationsFolder([
      { tag: '0035_base', when: 1_000, sql: 'CREATE TABLE lane_base (id int);\n' },
      { tag: '0320_track_a', when: 2_000, sql: 'CREATE TABLE lane_a (id int);\n' },
    ]);
    folders.push(dir);

    await migrate(owner.db, { migrationsFolder: dir });

    // 0035 then 0320: the gap in the numbers means nothing to the migrator.
    expect(await tables()).toEqual(expect.arrayContaining(['lane_base', 'lane_a']));

    // Track B is merged after A but was stamped earlier (1_500): the database already ran 2_000.
    const { journal } = await readFolder(dir);
    journal.entries.push({
      idx: 2,
      version: '7',
      when: 1_500,
      tag: '0340_track_b',
      breakpoints: true,
    });
    await writeJournal(dir, journal);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(`${dir}/0340_track_b.sql`, 'CREATE TABLE lane_b (id int);\n');

    await migrate(owner.db, { migrationsFolder: dir });

    // The migrator did not complain and did not run it: a silent skip.
    expect(await tables()).not.toContain('lane_b');
    // That is exactly what the check refuses, before it ever reaches a database.
    expect((await checkJournalFolder(dir)).map((problem) => problem.code)).toContain(
      'non_monotonic_when',
    );
  });

  it('runs the skipped migration once db:restamp has raised its stamp', async () => {
    const dir = await makeMigrationsFolder([
      { tag: '0035_base', when: 1_000, sql: 'CREATE TABLE lane_base (id int);\n' },
      { tag: '0320_track_a', when: 2_000, sql: 'CREATE TABLE lane_a (id int);\n' },
      { tag: '0340_track_b', when: 1_500, sql: 'CREATE TABLE lane_c (id int);\n' },
    ]);
    folders.push(dir);

    const report = await restampFolder(dir);
    await migrate(owner.db, { migrationsFolder: dir });

    expect(report.restamped).toEqual(['0340_track_b']);
    expect(await tables()).toContain('lane_c');
    expect(await checkJournalFolder(dir)).toEqual([]);
  });
});

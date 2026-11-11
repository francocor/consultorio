import { rm } from 'node:fs/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { makeMigrationsFolder } from '../../scripts/migration-folder.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * Judgment day round 2, finding R2-C1. Drizzle runs every pending migration in ONE transaction, so
 * a `VALIDATE CONSTRAINT` inside a migration keeps the ACCESS EXCLUSIVE lock of the `ADD CONSTRAINT`
 * before it until the end of the run. The way to have a constraint added without that cost is to
 * leave it NOT VALID in the migration and let `runMigrations` validate it afterwards, outside the
 * transaction, where the lock only stops other schema changes. This runs the real runner against a
 * throwaway database, with a constraint whose check is slow on purpose, and shows a writer going on
 * while the validation is running.
 */
const DATABASE = 'migrate_validation_probe';

let probeUrl: string;
let folder: string;

const MIGRATION = [
  `CREATE FUNCTION slow_ok(value integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN value = 1 THEN pg_sleep(4) IS NOT NULL ELSE true END $$;`,
  `CREATE TABLE probe_rows (id serial PRIMARY KEY, value integer NOT NULL);`,
  `INSERT INTO probe_rows (value) VALUES (1), (2), (3);`,
  `ALTER TABLE probe_rows ADD CONSTRAINT probe_rows_slow_check CHECK (slow_ok(value)) NOT VALID;`,
].join('\n--> statement-breakpoint\n');

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DATABASE} OWNER app_owner`);
  } finally {
    await admin.end();
  }
  const url = new URL(inject('ownerUrl'));
  url.pathname = `/${DATABASE}`;
  probeUrl = url.toString();
  folder = await makeMigrationsFolder([
    { tag: '0390_probe_not_valid', when: 1_000, sql: MIGRATION },
  ]);
}, 60_000);

afterAll(async () => {
  await rm(folder, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: inject('adminUrl') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

describe('constraints left NOT VALID by a migration', () => {
  it('are validated by the runner after the migrations, without stopping a concurrent writer', async () => {
    const writer = new pg.Client({ connectionString: probeUrl });
    await writer.connect();
    try {
      const running = runMigrations(probeUrl, [], { migrationsFolder: folder });

      // Wait until the validation is the statement that is running (it sleeps in the check).
      const deadline = Date.now() + 20_000;
      let validating = false;
      while (!validating && Date.now() < deadline) {
        const activity = await writer.query<{ query: string }>(
          `SELECT query FROM pg_stat_activity
            WHERE datname = $1 AND query ILIKE '%VALIDATE CONSTRAINT%' AND pid <> pg_backend_pid()`,
          [DATABASE],
        );
        validating = activity.rows.length > 0;
        if (!validating) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(validating).toBe(true);

      const started = Date.now();
      await writer.query('SET lock_timeout = 1500');
      await writer.query('INSERT INTO probe_rows (value) VALUES (5)');
      expect(Date.now() - started).toBeLessThan(2_000);

      await running;
    } finally {
      await writer.end();
    }

    const owner = new pg.Client({ connectionString: probeUrl });
    await owner.connect();
    try {
      const state = await owner.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'probe_rows_slow_check'`,
      );
      expect(state.rows).toEqual([{ convalidated: true }]);
    } finally {
      await owner.end();
    }
  }, 40_000);
});

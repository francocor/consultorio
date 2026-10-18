import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

import { createOwnerDb } from '../platform/db/pool.js';
import { installJobs } from '../platform/jobs/install.js';
import type { QueueDefinition } from '../platform/jobs/queues.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

export interface MigrationOptions {
  /** A folder other than the application's own (tests of the runner). */
  migrationsFolder?: string;
}

/**
 * Validates every constraint a migration left NOT VALID, one statement at a time and outside the
 * transaction the migrator runs in. Drizzle applies all pending migrations in a single transaction,
 * so a `VALIDATE CONSTRAINT` written inside a migration would keep the ACCESS EXCLUSIVE lock of the
 * `ADD CONSTRAINT` before it until the whole run ends. Here the validation takes only a SHARE UPDATE
 * EXCLUSIVE lock, which lets reads and writes go on while the existing rows are scanned.
 * A migration that adds a constraint to a table with many rows states it NOT VALID and leaves the
 * validation to this step. It is safe to run again: it only touches what is still unvalidated.
 */
export async function validateDeferredConstraints(pool: Pool): Promise<string[]> {
  const pending = await pool.query<{ table_name: string; constraint_name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS table_name, k.conname AS constraint_name
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT k.convalidated AND n.nspname = 'public' AND k.contype IN ('c', 'f')
      ORDER BY c.relname, k.conname`,
  );
  const validated: string[] = [];
  for (const row of pending.rows) {
    await pool.query(
      `ALTER TABLE ${row.table_name} VALIDATE CONSTRAINT ${quoteIdentifier(row.constraint_name)}`,
    );
    validated.push(`${row.table_name}.${row.constraint_name}`);
  }
  return validated;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Applies pending migrations as the owner role, validates the constraints they left NOT VALID, then
 * installs or upgrades the pg-boss schema and its queues (also as the owner). Migrations are
 * forward-only.
 *
 * @param extraQueues queues to create besides the application's own (tests add theirs)
 */
export async function runMigrations(
  migrationDatabaseUrl: string,
  extraQueues: readonly QueueDefinition[] = [],
  options: MigrationOptions = {},
): Promise<void> {
  const handle = createOwnerDb(migrationDatabaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
    await validateDeferredConstraints(handle.pool);
  } finally {
    await handle.close();
  }
  await installJobs(migrationDatabaseUrl, extraQueues);
}

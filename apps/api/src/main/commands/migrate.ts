import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { MIGRATIONS_FOLDER, runMigrations } from '../../db/migrate.js';
import { seedPlatformCatalogs } from '../../db/seed/platform.js';
import { createOwnerDb } from '../../platform/db/pool.js';

import { EXIT, finish, type CommandIo } from './io.js';

/**
 * `main.js migrate`: applies the migrations and loads the platform catalogs (the payers, the
 * holidays), so a new database is usable after one command. Safe to run again: it applies what is
 * pending and nothing else.
 *
 * Input: `MIGRATION_DATABASE_URL` (the login that owns the schema) and, optionally, `MIGRATIONS_DIR`: a
 * folder with the `*.sql` files and `meta/_journal.json`. Without it the migrations that sit next to
 * the bundle (`dist/migrations`) or next to the source are used.
 *
 * Output: plain progress lines on the standard output, exit 0. A failure is a JSON line on the
 * standard error with the message of the database, and one of the codes of `EXIT`.
 */
export async function runMigrate(io: CommandIo): Promise<number> {
  const url = io.env['MIGRATION_DATABASE_URL'];
  if (!url) {
    return finish(io, EXIT.config, {
      error: 'invalid_config',
      message: 'MIGRATION_DATABASE_URL: is required',
    });
  }
  const folder = io.env['MIGRATIONS_DIR'] || MIGRATIONS_FOLDER;
  if (!existsSync(join(folder, 'meta', '_journal.json'))) {
    return finish(io, EXIT.config, {
      error: 'invalid_config',
      message: 'MIGRATIONS_DIR: has no meta/_journal.json, so it is not a folder of migrations',
    });
  }
  try {
    await runMigrations(url, [], { migrationsFolder: folder });
    io.stdout('migrations applied\n');
    // The payer catalog and the holidays are data every organization reads; load them here so a
    // fresh database is usable without a second command.
    const owner = createOwnerDb(url);
    try {
      await seedPlatformCatalogs(owner.db);
      io.stdout('platform catalogs loaded\n');
    } finally {
      await owner.close();
    }
    return EXIT.ok;
  } catch (error) {
    // The message of the database is what explains the failure; connection strings are never part of it.
    return finish(io, EXIT.failed, {
      error: 'failed',
      message: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

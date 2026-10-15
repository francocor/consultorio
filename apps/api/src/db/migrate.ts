import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createOwnerDb } from '../platform/db/pool.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

/** Applies pending migrations as the owner role. Migrations are forward-only. */
export async function runMigrations(migrationDatabaseUrl: string): Promise<void> {
  const handle = createOwnerDb(migrationDatabaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

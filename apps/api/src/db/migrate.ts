import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createOwnerDb } from '../platform/db/pool.js';
import { installJobs } from '../platform/jobs/install.js';
import type { QueueDefinition } from '../platform/jobs/queues.js';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Applies pending migrations as the owner role, then installs or upgrades the pg-boss schema and
 * its queues (also as the owner). Migrations are forward-only.
 *
 * @param extraQueues queues to create besides the application's own (tests add theirs)
 */
export async function runMigrations(
  migrationDatabaseUrl: string,
  extraQueues: readonly QueueDefinition[] = [],
): Promise<void> {
  const handle = createOwnerDb(migrationDatabaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
  await installJobs(migrationDatabaseUrl, extraQueues);
}

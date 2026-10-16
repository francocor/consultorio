import { createOwnerDb } from '../platform/db/pool.js';

import { runMigrations } from './migrate.js';
import { seedPlatformCatalogs } from './seed/platform.js';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) {
  process.stderr.write('MIGRATION_DATABASE_URL is required\n');
  process.exit(1);
}

async function main(connection: string): Promise<void> {
  await runMigrations(connection);
  process.stdout.write('migrations applied\n');
  // The payer catalog and the holidays are data every organization reads; load them here so a
  // fresh database is usable without a second command.
  const owner = createOwnerDb(connection);
  try {
    await seedPlatformCatalogs(owner.db);
    process.stdout.write('platform catalogs loaded\n');
  } finally {
    await owner.close();
  }
}

main(url).catch((error: unknown) => {
  // Operator-run command: the database message is what explains the failure. Connection
  // strings are never part of driver error messages.
  process.stderr.write(
    `migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(1);
});

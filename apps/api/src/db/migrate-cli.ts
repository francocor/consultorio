import { runMigrations } from './migrate.js';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) {
  process.stderr.write('MIGRATION_DATABASE_URL is required\n');
  process.exit(1);
}

runMigrations(url).then(
  () => {
    process.stdout.write('migrations applied\n');
  },
  (error: unknown) => {
    // Operator-run command: the database message is what explains the failure. Connection
    // strings are never part of driver error messages.
    process.stderr.write(
      `migration failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
    process.exit(1);
  },
);

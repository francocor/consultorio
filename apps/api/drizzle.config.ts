import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit runs as the migration owner. `MIGRATION_DATABASE_URL` is only needed for commands
 * that talk to a database (`db:migrate`); `generate` and `check` work from the schema files alone.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dbCredentials: { url: process.env['MIGRATION_DATABASE_URL'] ?? '' },
  strict: true,
  verbose: true,
});

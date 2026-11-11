import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateInScratch } from './drizzle-scratch.js';
import { checkJournalFolder, type JournalProblem } from './migration-journal.js';

export interface DriftOptions {
  /** Entry file that re-exports every Drizzle table. */
  schemaFile: string;
  /** Folder holding the committed `.sql` migrations and `meta/`. */
  migrationsDir: string;
  /** Scratch parent directory. It must sit inside the package so `drizzle-orm` resolves. */
  scratchDir: string;
}

export interface DriftResult {
  drift: boolean;
  /** Names of migrations the current schema would still need. Empty when there is no drift. */
  missing: string[];
  /**
   * What is wrong with the journal itself: a stamp that does not rise, a duplicate tag or number, a
   * number outside every range, a missing file, a broken snapshot chain. When there are any, the
   * schema is not compared: drizzle-kit's answer would not mean anything.
   */
  problems: JournalProblem[];
  /** Output of drizzle-kit, for the failure message. */
  output: string;
}

/**
 * Fails when the migration folder is not sound, or when the Drizzle schema and the folder disagree.
 *
 * First the journal is checked (`migration-journal.ts`). Then it copies the committed migrations
 * to a scratch folder and asks drizzle-kit to generate the migration for the current schema there.
 * If drizzle-kit writes a new `.sql` file, the schema has changes nobody turned into a migration.
 * The committed folder is never modified.
 */
export async function checkMigrationDrift(options: DriftOptions): Promise<DriftResult> {
  const problems = await checkJournalFolder(options.migrationsDir);
  if (problems.length > 0) return { drift: false, missing: [], problems, output: '' };

  const generated = await generateInScratch(options);
  const missing = generated.sql ? [generated.sql.fileName] : [];
  return { drift: missing.length > 0, missing, problems: [], output: generated.output };
}

async function main(): Promise<void> {
  const apiRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = await checkMigrationDrift({
    schemaFile: join(apiRoot, 'src/db/schema/index.ts'),
    migrationsDir: join(apiRoot, 'src/db/migrations'),
    scratchDir: join(apiRoot, 'node_modules/.cache/migration-drift'),
  });

  if (result.problems.length > 0) {
    process.stderr.write(
      `The migration folder is not sound:\n${result.problems.map((problem) => `- ${problem.message}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  if (result.drift) {
    process.stderr.write(
      'Schema and migrations disagree. Run "pnpm db:new <track> <name>" (docs/migration-ranges.md) and commit the result.\n' +
        `Pending: ${result.missing.join(', ')}\n`,
    );
    process.exit(1);
  }
  process.stdout.write('No migration drift.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `Drift check failed: ${error instanceof Error ? error.message : 'error'}\n`,
    );
    process.exit(1);
  });
}

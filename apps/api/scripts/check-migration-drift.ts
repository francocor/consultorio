import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

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
  /** Output of drizzle-kit, for the failure message. */
  output: string;
}

async function sqlFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
}

/**
 * Fails when the Drizzle schema and the migration folder disagree.
 *
 * It copies the committed migrations to a scratch folder and asks drizzle-kit to generate the
 * migration for the current schema there. If drizzle-kit writes a new `.sql` file, the schema has
 * changes nobody turned into a migration. The committed folder is never modified.
 */
export async function checkMigrationDrift(options: DriftOptions): Promise<DriftResult> {
  await mkdir(options.scratchDir, { recursive: true });
  const scratch = await mkdtemp(join(options.scratchDir, 'drift-'));
  try {
    const outName = 'migrations';
    const out = join(scratch, outName);
    await cp(options.migrationsDir, out, { recursive: true });
    const before = await sqlFiles(out);

    const config = join(scratch, 'drizzle.config.ts');
    await writeFile(
      config,
      `export default ${JSON.stringify({
        dialect: 'postgresql',
        // drizzle-kit resolves these against its working directory, so they are relative.
        schema: relative(scratch, options.schemaFile).replaceAll('\\', '/'),
        out: outName,
      })};\n`,
    );

    // The package does not export its bin, so locate it next to the main entry file.
    const cli = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
    const { stdout, stderr } = await run(process.execPath, [cli, 'generate', '--config', config], {
      cwd: scratch,
    });

    const missing = (await sqlFiles(out)).filter((name) => !before.includes(name));
    return { drift: missing.length > 0, missing, output: `${stdout}${stderr}`.trim() };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const apiRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = await checkMigrationDrift({
    schemaFile: join(apiRoot, 'src/db/schema/index.ts'),
    migrationsDir: join(apiRoot, 'src/db/migrations'),
    scratchDir: join(apiRoot, 'node_modules/.cache/migration-drift'),
  });

  if (result.drift) {
    process.stderr.write(
      'Schema and migrations disagree. Run "pnpm --filter @consultorio/api db:generate" and commit the result.\n' +
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

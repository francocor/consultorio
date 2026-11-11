import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

/**
 * Bundles the API, the worker and the one-shot commands into `<outdir>/main.js` so
 * `node dist/main.js api` runs without a TypeScript loader.
 *
 * Workspace packages (`@consultorio/*`, such as `@consultorio/contracts`) export raw TypeScript, so they are
 * inlined. Third-party runtime dependencies stay external and are installed into the image
 * (`pnpm deploy --prod`), which keeps native modules and their licences intact.
 *
 * The migrator needs its SQL at run time, so the migrations ship beside the bundle in
 * `<outdir>/migrations`: the `*.sql` files and `meta/_journal.json`, which is all the migrator reads.
 * The snapshots in `meta/` are for the tools that write migrations and weigh dozens of megabytes.
 */
const root = fileURLToPath(new URL('..', import.meta.url));

export const MIGRATIONS_SOURCE = join(root, 'src', 'db', 'migrations');

/** Copies the SQL of every migration of the journal, and the journal, into `target`. */
export async function copyMigrations(source: string, target: string): Promise<number> {
  const journalText = await readFile(join(source, 'meta', '_journal.json'), 'utf8');
  const journal = JSON.parse(journalText) as { entries: { tag: string }[] };
  await rm(target, { recursive: true, force: true });
  await mkdir(join(target, 'meta'), { recursive: true });
  // A journal entry without its file would fail on the customer's PC; fail the build instead.
  for (const { tag } of journal.entries) {
    await copyFile(join(source, `${tag}.sql`), join(target, `${tag}.sql`));
  }
  await copyFile(join(source, 'meta', '_journal.json'), join(target, 'meta', '_journal.json'));
  return journal.entries.length;
}

export async function buildBundle(options: { outdir?: string } = {}): Promise<void> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const external = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !name.startsWith('@consultorio/'),
  );
  const outdir = options.outdir ?? 'dist';
  const absolute = isAbsolute(outdir) ? outdir : join(root, outdir);

  await rm(absolute, { recursive: true, force: true });
  await build({
    absWorkingDir: root,
    entryPoints: { main: 'src/main/main.ts' },
    outdir: absolute,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    external,
    logLevel: options.outdir === undefined ? 'info' : 'silent',
  });
  await copyMigrations(MIGRATIONS_SOURCE, join(absolute, 'migrations'));
}

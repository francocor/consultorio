import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import {
  formatPrefix,
  prefixOf,
  readFolder,
  JOURNAL_FILE,
  type Journal,
} from './migration-journal.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);

export interface ScratchOptions {
  /** Entry file that re-exports every Drizzle table. */
  schemaFile: string;
  /** Folder holding the committed `.sql` migrations and `meta/`. It is never modified. */
  migrationsDir: string;
  /** Scratch parent directory. It must sit inside the package so `drizzle-orm` resolves. */
  scratchDir: string;
  /** The name part of the migration drizzle-kit is asked to write. */
  name?: string;
  /**
   * Forget the last journal entry first, so drizzle-kit describes the difference between the
   * schema and the snapshot BEFORE it. That difference always includes the last migration, which
   * is how the last snapshot is rebuilt after a merge.
   */
  dropLast?: boolean;
}

export interface ScratchResult {
  /** The migration drizzle-kit wrote for the schema, or null when the schema has no news. */
  sql: { fileName: string; content: string } | null;
  /** The snapshot of the schema as it is now, or null when drizzle-kit wrote nothing. */
  snapshot: Record<string, unknown> | null;
  /** What drizzle-kit printed, for a failure message. */
  output: string;
}

/**
 * Asks drizzle-kit what migration the current schema still needs, in a scratch copy of the folder.
 *
 * drizzle-kit takes the LAST snapshot by file name as the state of the database and names the next
 * file by the last `idx`. Ranges break the first rule (0340 sorts after 0322 even when 0322 was
 * merged later), so in the scratch copy the snapshots are renamed by their position in the journal.
 * The committed folder keeps its range names.
 */
export async function generateInScratch(options: ScratchOptions): Promise<ScratchResult> {
  await mkdir(options.scratchDir, { recursive: true });
  const scratch = await mkdtemp(join(options.scratchDir, 'generate-'));
  try {
    const outName = 'migrations';
    const out = join(scratch, outName);
    await cp(options.migrationsDir, out, { recursive: true });

    const journal = (await readFolder(out)).journal;
    const kept: Journal = options.dropLast
      ? { ...journal, entries: journal.entries.slice(0, -1) }
      : journal;
    if (options.dropLast) {
      const last = journal.entries.at(-1);
      const prefix = last ? prefixOf(last.tag) : null;
      if (last && prefix !== null) {
        await rm(join(out, `${last.tag}.sql`), { force: true });
        await rm(join(out, 'meta', `${formatPrefix(prefix)}_snapshot.json`), { force: true });
      }
    }
    await writeFile(join(out, JOURNAL_FILE), JSON.stringify(kept, null, 2));

    // Two phases, so a rename never lands on a file that has not been renamed yet.
    const meta = join(out, 'meta');
    for (const [position, entry] of kept.entries.entries()) {
      const prefix = prefixOf(entry.tag);
      if (prefix === null) continue;
      await rename(
        join(meta, `${formatPrefix(prefix)}_snapshot.json`),
        join(meta, `.position-${String(position)}`),
      );
    }
    for (const position of kept.entries.keys()) {
      await rename(
        join(meta, `.position-${String(position)}`),
        join(meta, `${formatPrefix(position)}_snapshot.json`),
      );
    }

    const before = new Set([...(await readdir(out)), ...(await readdir(meta))]);
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
    const args = [
      cli,
      'generate',
      '--config',
      config,
      ...(options.name ? ['--name', options.name] : []),
    ];
    const { stdout, stderr } = await run(process.execPath, args, { cwd: scratch });

    const written = (await readdir(out)).filter(
      (name) => name.endsWith('.sql') && !before.has(name),
    );
    const snapshots = (await readdir(meta)).filter(
      (name) => name.endsWith('_snapshot.json') && !before.has(name),
    );
    const fileName = written[0];
    const snapshotName = snapshots[0];
    return {
      sql: fileName ? { fileName, content: await readFile(join(out, fileName), 'utf8') } : null,
      snapshot: snapshotName
        ? (JSON.parse(await readFile(join(meta, snapshotName), 'utf8')) as Record<string, unknown>)
        : null,
      output: `${stdout}${stderr}`.trim(),
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

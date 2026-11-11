import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Builds a throwaway migrations folder (the journal, one `.sql` and one snapshot per entry) for the
 * tests of the migration tools. The snapshots are tiny and valid for the chain checks, not for
 * drizzle-kit: they hold no tables.
 */
export interface FolderEntry {
  tag: string;
  when: number;
  /** The SQL of the file. Defaults to a comment. */
  sql?: string;
}

export const ZERO_ID = '00000000-0000-0000-0000-000000000000';

/** A snapshot id derived from the prefix, so a test can name the id it expects. */
export function snapshotId(prefix: string): string {
  return `00000000-0000-4000-8000-${prefix.padStart(12, '0')}`;
}

export async function makeMigrationsFolder(entries: readonly FolderEntry[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
  await mkdir(join(dir, 'meta'), { recursive: true });
  let previousId = ZERO_ID;
  const journal = {
    version: '7',
    dialect: 'postgresql',
    entries: entries.map((entry, idx) => ({
      idx,
      version: '7',
      when: entry.when,
      tag: entry.tag,
      breakpoints: true,
    })),
  };
  for (const entry of entries) {
    const prefix = entry.tag.slice(0, 4);
    const id = snapshotId(prefix);
    await writeFile(join(dir, `${entry.tag}.sql`), entry.sql ?? `-- ${entry.tag}\n`);
    await writeFile(
      join(dir, 'meta', `${prefix}_snapshot.json`),
      `${JSON.stringify({ id, prevId: previousId, version: '7', dialect: 'postgresql', tables: {} }, null, 2)}\n`,
    );
    previousId = id;
  }
  await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal, null, 2));
  return dir;
}

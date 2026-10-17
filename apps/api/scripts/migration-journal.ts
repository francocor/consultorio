import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The rules of the migration folder, in one place for the three tools that touch it
 * (`db:check`, `db:new` and `db:restamp`). The convention is written in `docs/migration-ranges.md`.
 *
 * Why the numbers are only a naming convention: Drizzle's migrator applies the entries of the
 * journal that are NEWER (by `when`) than the last one applied to a database, in journal order, and
 * never looks at the number in a tag. So ranges per stage and per track are compatible with it, and
 * they keep two branches from ever producing two files with the same name. What the migrator does
 * need is a journal whose `when` rises, which is the first thing checked here.
 */

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/**
 * Stages 0 to 2 are one linear sequence below 0300, numbered by `drizzle-kit generate` itself (the
 * Stage 2 branch keeps adding to it while Stage 3 is built). `db:restamp` never touches it.
 */
export const FROZEN_LAST_PREFIX = 299;

interface Range {
  start: number;
  end: number;
}

/** A hundred numbers per later stage. */
const STAGE_RANGES: readonly (Range & { name: string })[] = [
  { name: 'stage 0 to 2', start: 0, end: FROZEN_LAST_PREFIX },
  { name: 'stage 3', start: 300, end: 399 },
  { name: 'stage 4', start: 400, end: 499 },
  { name: 'stage 5', start: 500, end: 599 },
  { name: 'stage 6', start: 600, end: 699 },
];

/**
 * The range of each parallel track (`tasks.md`, "Parallel tracks" of each stage). `3seam` is for the
 * seam slices, the letters are the tracks, and the last track of a stage is the integration one.
 */
export const TRACK_RANGES: Readonly<Record<string, Range & { label: string }>> = {
  '3seam': { start: 300, end: 319, label: 'Stage 3 seams' },
  '3a': { start: 320, end: 339, label: 'Stage 3, A messaging' },
  '3b': { start: 340, end: 359, label: 'Stage 3, B public booking' },
  '3c': { start: 360, end: 369, label: 'Stage 3, C waitlist' },
  '3d': { start: 370, end: 379, label: 'Stage 3, D teleconsultation' },
  '3e': { start: 390, end: 399, label: 'Stage 3, E integration' },
  '4seam': { start: 400, end: 409, label: 'Stage 4 seams' },
  '4a': { start: 410, end: 429, label: 'Stage 4, A billing' },
  '4b': { start: 430, end: 439, label: 'Stage 4, B reports' },
  '4c': { start: 440, end: 469, label: 'Stage 4, C invoicing' },
  '4d': { start: 490, end: 499, label: 'Stage 4, D integration' },
  '5seam': { start: 500, end: 504, label: 'Stage 5 seams' },
  '5a1': { start: 505, end: 509, label: 'Stage 5, A1 verification' },
  '5a2': { start: 510, end: 529, label: 'Stage 5, A2 consent' },
  '5a3': { start: 530, end: 549, label: 'Stage 5, A3 e-prescription' },
  '5b': { start: 550, end: 579, label: 'Stage 5, B portal' },
  '5c': { start: 590, end: 599, label: 'Stage 5, C integration' },
  '6seam': { start: 600, end: 609, label: 'Stage 6 seams' },
  '6a': { start: 610, end: 639, label: 'Stage 6, A subscriptions' },
  '6b': { start: 640, end: 649, label: 'Stage 6, B signup' },
  '6c': { start: 650, end: 679, label: 'Stage 6, C retention' },
  '6d': { start: 690, end: 699, label: 'Stage 6, D readiness' },
};

const TAG = /^(\d{4})_[a-z0-9_]+$/;

/** The number a tag starts with, or null when it does not follow `NNNN_name`. */
export function prefixOf(tag: string): number | null {
  const match = TAG.exec(tag);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function formatPrefix(prefix: number): string {
  return String(prefix).padStart(4, '0');
}

/** The stage a number belongs to, or null when it is in no range (a gap, or past Stage 6). */
export function stageRangeOf(prefix: number): string | null {
  return STAGE_RANGES.find((range) => prefix >= range.start && prefix <= range.end)?.name ?? null;
}

export type JournalProblemCode =
  | 'bad_idx'
  | 'bad_tag'
  | 'duplicate_tag'
  | 'duplicate_prefix'
  | 'out_of_range_prefix'
  | 'non_monotonic_when'
  | 'missing_sql'
  | 'orphan_sql'
  | 'missing_snapshot'
  | 'broken_snapshot_chain';

export interface JournalProblem {
  code: JournalProblemCode;
  tag?: string;
  message: string;
}

export interface SnapshotInfo {
  id: string;
  prevId: string;
}

export interface FolderState {
  journal: Journal;
  sqlFiles: string[];
  /** Keyed by the four digit prefix of the file name (`0320_snapshot.json` is `0320`). */
  snapshots: Map<string, SnapshotInfo>;
}

const ZERO_ID = '00000000-0000-0000-0000-000000000000';

const FIX_WITH_RESTAMP = 'Run "pnpm db:restamp" after the merge or rebase.';

/** Everything that can be wrong with the folder, as problems rather than a first exception. */
export function checkJournal(state: FolderState): JournalProblem[] {
  const problems: JournalProblem[] = [];
  const { journal } = state;
  const seenTags = new Set<string>();
  const seenPrefixes = new Set<number>();
  let previousWhen: number | null = null;
  let previousSnapshot: SnapshotInfo | undefined;

  journal.entries.forEach((entry, position) => {
    if (entry.idx !== position) {
      problems.push({
        code: 'bad_idx',
        tag: entry.tag,
        message: `${entry.tag} has idx ${String(entry.idx)}, expected ${String(position)}. ${FIX_WITH_RESTAMP}`,
      });
    }

    const prefix = prefixOf(entry.tag);
    if (prefix === null) {
      problems.push({
        code: 'bad_tag',
        tag: entry.tag,
        message: `${entry.tag} does not follow NNNN_name (four digits, then lowercase words).`,
      });
    } else {
      if (stageRangeOf(prefix) === null) {
        problems.push({
          code: 'out_of_range_prefix',
          tag: entry.tag,
          message: `${entry.tag} is outside every range of docs/migration-ranges.md. Create migrations with "pnpm db:new <track> <name>", never with "db:generate".`,
        });
      }
      if (seenPrefixes.has(prefix)) {
        problems.push({
          code: 'duplicate_prefix',
          tag: entry.tag,
          message: `The number ${formatPrefix(prefix)} is used by two migrations; their snapshots would overwrite each other.`,
        });
      }
      seenPrefixes.add(prefix);
    }

    if (seenTags.has(entry.tag)) {
      problems.push({
        code: 'duplicate_tag',
        tag: entry.tag,
        message: `${entry.tag} appears twice in the journal.`,
      });
    }
    seenTags.add(entry.tag);

    if (previousWhen !== null && entry.when <= previousWhen) {
      problems.push({
        code: 'non_monotonic_when',
        tag: entry.tag,
        message: `${entry.tag} has a stamp (${String(entry.when)}) that is not later than the entry before it (${String(previousWhen)}). On a database that already ran the earlier entry the migrator would skip it silently. ${FIX_WITH_RESTAMP}`,
      });
    }
    previousWhen = entry.when;

    if (!state.sqlFiles.includes(`${entry.tag}.sql`)) {
      problems.push({
        code: 'missing_sql',
        tag: entry.tag,
        message: `${entry.tag} is in the journal but ${entry.tag}.sql does not exist.`,
      });
    }

    if (prefix !== null) {
      const snapshot = state.snapshots.get(formatPrefix(prefix));
      if (!snapshot) {
        problems.push({
          code: 'missing_snapshot',
          tag: entry.tag,
          message: `${entry.tag} has no meta/${formatPrefix(prefix)}_snapshot.json.`,
        });
      } else {
        const expectedParent = previousSnapshot?.id ?? ZERO_ID;
        if (snapshot.prevId !== expectedParent && position > 0) {
          problems.push({
            code: 'broken_snapshot_chain',
            tag: entry.tag,
            message: `The snapshot of ${entry.tag} does not follow the one before it in the journal (two branches both continued the same snapshot). ${FIX_WITH_RESTAMP}`,
          });
        }
        previousSnapshot = snapshot;
      }
    }
  });

  const tags = new Set(journal.entries.map((entry) => entry.tag));
  for (const file of state.sqlFiles) {
    const tag = file.replace(/\.sql$/, '');
    if (!tags.has(tag)) {
      problems.push({
        code: 'orphan_sql',
        tag,
        message: `${file} has no entry in the journal, so it would never run.`,
      });
    }
  }
  return problems;
}

export const JOURNAL_FILE = join('meta', '_journal.json');

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

export async function readFolder(migrationsDir: string): Promise<FolderState> {
  const journal = await readJson<Journal>(join(migrationsDir, JOURNAL_FILE));
  const sqlFiles = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  const snapshots = new Map<string, SnapshotInfo>();
  for (const name of await readdir(join(migrationsDir, 'meta'))) {
    const match = /^(\d{4})_snapshot\.json$/.exec(name);
    if (match?.[1] === undefined) continue;
    const snapshot = await readJson<SnapshotInfo>(join(migrationsDir, 'meta', name));
    snapshots.set(match[1], { id: snapshot.id, prevId: snapshot.prevId });
  }
  return { journal, sqlFiles, snapshots };
}

export async function checkJournalFolder(migrationsDir: string): Promise<JournalProblem[]> {
  return checkJournal(await readFolder(migrationsDir));
}

/**
 * Writes the journal the way drizzle-kit does (two spaces, no trailing newline), so a tool never
 * shows up as a formatting change in a diff.
 */
export async function writeJournal(migrationsDir: string, journal: Journal): Promise<void> {
  await writeFile(join(migrationsDir, JOURNAL_FILE), JSON.stringify(journal, null, 2));
}

/**
 * The journal with `idx` renumbered 0, 1, 2 ... and `when` raised where it does not rise. Entries
 * of the linear sequence of Stages 0 to 2 (below 0300) are never touched: databases already ran them with these
 * stamps. Every other entry keeps its stamp when it is already later than the one before it, so
 * only the entries that a merge put out of order change.
 */
export function restampJournal(journal: Journal): Journal {
  let previousWhen = 0;
  const entries = journal.entries.map((entry, position) => {
    const prefix = prefixOf(entry.tag);
    const frozen = prefix !== null && prefix <= FROZEN_LAST_PREFIX;
    const when = frozen ? entry.when : Math.max(entry.when, previousWhen + 1);
    previousWhen = when;
    return { ...entry, idx: position, when };
  });
  return { ...journal, entries };
}

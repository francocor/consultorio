import base from './no-delete.allowlist.json' with { type: 'json' };

export interface CodeEntry {
  file: string;
  table: string;
  why: string;
}
export interface SqlEntry {
  file: string;
  why: string;
}
export interface EphemeralEntry {
  table: string;
  why: string;
}

export interface Allowlist {
  code: CodeEntry[];
  sql: SqlEntry[];
  ephemeralTables: EphemeralEntry[];
}

/** Joins allowlists. An entry two of them both list is an error. */
export function mergeAllowlists(lists: readonly Allowlist[]): Allowlist {
  const merged: Allowlist = { code: [], sql: [], ephemeralTables: [] };
  const seen = new Set<string>();
  const once = (key: string) => {
    if (seen.has(key)) throw new Error(`The allowlist lists ${key} twice.`);
    seen.add(key);
  };
  for (const list of lists) {
    for (const entry of list.code) {
      once(`code ${entry.file} ${entry.table}`);
      merged.code.push(entry);
    }
    for (const entry of list.sql) {
      once(`sql ${entry.file}`);
      merged.sql.push(entry);
    }
    for (const entry of list.ephemeralTables) {
      once(`table ${entry.table}`);
      merged.ephemeralTables.push(entry);
    }
  }
  return merged;
}

/**
 * Every file of `test/policy/no-delete/` has the same shape as the base list and belongs to one
 * track (the online-booking purge adds `booking.json`), so a track never edits the shared list.
 */
const extras = import.meta.glob<Partial<Allowlist>>('./no-delete/*.json', {
  eager: true,
  import: 'default',
});

/** The files the glob found (`booking.json`, ...), so a test can tell when the glob is stale. */
export const EXTRA_ALLOWLIST_FILES: readonly string[] = Object.keys(extras).map((path) =>
  path.replace('./no-delete/', ''),
);

export const ALLOWLIST: Allowlist = mergeAllowlists([
  base,
  ...Object.values(extras).map((list) => ({
    code: list.code ?? [],
    sql: list.sql ?? [],
    ephemeralTables: list.ephemeralTables ?? [],
  })),
]);

/** Rows per table of the `public` schema. */
export type RowCounts = Readonly<Record<string, number>>;

export interface CountProblem {
  table: string;
  /** The rows the source had just before the dump, or null when it had no such table. */
  before: number | null;
  /** The rows the source had just after the dump. */
  after: number | null;
  /** The rows the copy has, or null when the copy has no such table. */
  restored: number | null;
}

/**
 * Compares the copy with the source, table by table. The source is counted before AND after the dump
 * because a live database moves while `pg_dump` runs (the queues, the sessions): a table is fine
 * when the copy has a number of rows between those two counts, which on a quiet database is exactly
 * the one count. A table missing from the copy, a table the source never had and a count outside the
 * range are problems, in table order.
 */
export function findCountProblems(
  before: RowCounts,
  after: RowCounts,
  restored: RowCounts,
): CountProblem[] {
  const tables = [
    ...new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(restored)]),
  ];
  const problems: CountProblem[] = [];
  for (const table of tables.sort()) {
    const low = before[table] ?? null;
    const high = after[table] ?? null;
    const copy = restored[table] ?? null;
    const known = [low, high].filter((value): value is number => value !== null);
    const fits =
      copy !== null && known.length > 0 && copy >= Math.min(...known) && copy <= Math.max(...known);
    if (!fits) problems.push({ table, before: low, after: high, restored: copy });
  }
  return problems;
}

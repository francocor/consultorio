export interface WeekRow {
  locationId: string;
  /** ISO weekday: 1 is Monday. */
  weekday: number;
  start: string;
  end: string;
}

/** Splits sorted weekdays into runs of consecutive days. */
function runsOf(days: readonly number[]): number[][] {
  const runs: number[][] = [];
  for (const day of days) {
    const last = runs.at(-1);
    if (last && last.at(-1) === day - 1) last.push(day);
    else runs.push([day]);
  }
  return runs;
}

/** "Lunes a viernes", "Martes y miércoles", "Lunes, miércoles y viernes". */
function describeDays(days: readonly number[], nameOf: (weekday: number) => string): string {
  const parts = runsOf(days).flatMap((run) => {
    const first = run[0] ?? 0;
    const last = run.at(-1) ?? first;
    // Two days next to each other read better as a list than as a range.
    if (run.length >= 3) return [`${nameOf(first)} a ${nameOf(last).toLowerCase()}`];
    return run.map((day) => nameOf(day));
  });
  const lowered = parts.map((part, index) => (index === 0 ? part : lowerFirst(part)));
  if (lowered.length <= 1) return lowered[0] ?? '';
  return `${lowered.slice(0, -1).join(', ')} y ${lowered.at(-1) ?? ''}`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Says a plain week in one line ("Lunes a viernes, 09:00–17:00"): one place, one interval a day,
 * the same on every working day. Anything else (several intervals, different times, two places)
 * returns `null`, and the caller sends the person to the full editor instead of flattening it.
 */
export function summarizeWeek(
  rows: readonly WeekRow[],
  nameOf: (weekday: number) => string,
): string | null {
  const first = rows[0];
  if (!first) return null;
  const days = new Set<number>();
  for (const row of rows) {
    const same =
      row.locationId === first.locationId && row.start === first.start && row.end === first.end;
    if (!same || days.has(row.weekday)) return null;
    days.add(row.weekday);
  }
  const sorted = [...days].toSorted((a, b) => a - b);
  return `${describeDays(sorted, nameOf)}, ${first.start}–${first.end}`;
}

/** Weekly working hours: the rules the form checks before it asks the server. */

export interface DayInterval {
  start: string;
  end: string;
}

export interface WeeklyRow extends DayInterval {
  locationId: string;
  weekday: number;
}

export type HoursProblem = 'end_before_start' | 'overlap';

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/;

/** Minutes since midnight of `HH:MM`; `24:00` is the end of the day. NaN when it is not a time. */
export function toMinutes(time: string): number {
  if (!CLOCK.test(time)) return Number.NaN;
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/**
 * The problem of each interval of one day (null when it is fine). Intervals may touch (one ends
 * when the next starts) but not overlap. An unfinished interval counts as ending before it starts.
 */
export function validateIntervals(intervals: readonly DayInterval[]): (HoursProblem | null)[] {
  const parsed = intervals.map((item) => ({
    start: toMinutes(item.start),
    end: toMinutes(item.end),
  }));
  return parsed.map((current, index) => {
    if (Number.isNaN(current.start) || Number.isNaN(current.end) || current.end <= current.start) {
      return 'end_before_start';
    }
    const overlaps = parsed.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        !Number.isNaN(other.start) &&
        !Number.isNaN(other.end) &&
        current.start < other.end &&
        other.start < current.end,
    );
    return overlaps ? 'overlap' : null;
  });
}

/** The intervals of one location by weekday, each day sorted by start time. */
export function groupByDay(
  rows: readonly WeeklyRow[],
  locationId: string,
): Map<number, DayInterval[]> {
  const days = new Map<number, DayInterval[]>();
  for (const row of rows) {
    if (row.locationId !== locationId) continue;
    const day = days.get(row.weekday) ?? [];
    day.push({ start: row.start, end: row.end });
    days.set(row.weekday, day);
  }
  for (const day of days.values()) day.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  return days;
}

/** `09:00–12:00 · 15:00–19:00`, for a collapsed view or an announcement. */
export function summarizeDay(intervals: readonly DayInterval[]): string {
  return intervals.map((item) => `${item.start}–${item.end}`).join(' · ');
}

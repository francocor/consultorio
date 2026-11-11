import { instantAtLocalMinute, weekdayOfDate } from './time.js';

/** A half-open range of instants, in milliseconds since the epoch. */
export interface TimeRange {
  start: number;
  end: number;
}

/** One interval of a weekday at a location, in minutes of the local day. */
export interface HoursRow {
  locationId: string;
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/**
 * Hours that replace the weekly default for a range of dates (both ends included). A period with no
 * rows means the professional does not work in the range.
 */
export interface HoursPeriod {
  dateFrom: string;
  dateTo: string;
  rows: readonly HoursRow[];
}

/** Sorts ranges and joins the ones that overlap or touch. */
export function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** What is left of the ranges once the cuts are taken out (for example blocks out of the hours). */
export function subtractRanges(
  ranges: readonly TimeRange[],
  cuts: readonly TimeRange[],
): TimeRange[] {
  const sortedCuts = mergeRanges(cuts);
  const result: TimeRange[] = [];
  for (const range of ranges) {
    let cursor = range.start;
    for (const cut of sortedCuts) {
      if (cut.end <= cursor) continue;
      if (cut.start >= range.end) break;
      if (cut.start > cursor) result.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < range.end) result.push({ start: cursor, end: range.end });
  }
  return result;
}

export function overlapsAny(ranges: readonly TimeRange[], range: TimeRange): boolean {
  return ranges.some((other) => other.start < range.end && range.start < other.end);
}

/**
 * The windows in which a professional works at a location on the given local dates, as instants.
 * A period of dates that covers a date replaces the weekly hours for that date; the minutes are read
 * in the location's zone, so daylight saving time moves the instants and not the wall clock.
 */
export function workingWindows(input: {
  zone: string;
  locationId: string;
  /** Local calendar dates (`YYYY-MM-DD`). */
  dates: readonly string[];
  weekly: readonly HoursRow[];
  periods: readonly HoursPeriod[];
}): TimeRange[] {
  const windows: TimeRange[] = [];
  for (const date of input.dates) {
    const weekday = weekdayOfDate(date);
    const period = input.periods.find((item) => item.dateFrom <= date && date <= item.dateTo);
    const rows = (period ? period.rows : input.weekly).filter(
      (row) => row.locationId === input.locationId && row.weekday === weekday,
    );
    for (const row of rows) {
      const start = instantAtLocalMinute(input.zone, date, row.startMinute).getTime();
      const end = instantAtLocalMinute(input.zone, date, row.endMinute, 'second').getTime();
      if (end > start) windows.push({ start, end });
    }
  }
  return mergeRanges(windows);
}

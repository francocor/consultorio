/**
 * Date arithmetic for the calendar, always in the time zone of the location (never the device's).
 *
 * Appointments are absolute instants. A day of the calendar is a LOCAL day of the location, which
 * can be 23 or 25 hours long where clocks change, so every conversion goes through `Intl` instead
 * of assuming 24 hours. Dates without a time are `YYYY-MM-DD` strings (calendar days, not instants).
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockOf(instant: Date, timeZone: string): WallClock {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values['year'] ?? 0,
    month: values['month'] ?? 1,
    day: values['day'] ?? 1,
    hour: values['hour'] ?? 0,
    minute: values['minute'] ?? 0,
    second: values['second'] ?? 0,
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The local calendar day (`YYYY-MM-DD`) an instant falls on at the location. */
export function localDateOf(instant: string | Date, timeZone: string): string {
  const clock = wallClockOf(toDate(instant), timeZone);
  return `${pad(clock.year, 4)}-${pad(clock.month)}-${pad(clock.day)}`;
}

/** Minutes since local midnight (0 to 1439) of an instant at the location. */
export function minutesOfDay(instant: string | Date, timeZone: string): number {
  const clock = wallClockOf(toDate(instant), timeZone);
  return clock.hour * 60 + clock.minute;
}

/** The offset of the zone from UTC at an instant, in milliseconds (east is positive). */
function offsetAt(instantMs: number, timeZone: string): number {
  const clock = wallClockOf(new Date(instantMs), timeZone);
  const wallAsUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year = 1970, month = 1, day = 1] = date.split('-').map(Number);
  return { year, month, day };
}

/**
 * The instant at which the wall clock of the location reads `minutes` after midnight on `date`.
 * A time that does not exist (clocks going forward) lands just after the gap; an ambiguous one
 * (clocks going back) resolves to its first occurrence.
 */
export function zonedInstant(date: string, minutes: number, timeZone: string): Date {
  const { year, month, day } = parseDate(date);
  const wallAsUtc = Date.UTC(year, month - 1, day) + minutes * MINUTE_MS;
  const first = wallAsUtc - offsetAt(wallAsUtc, timeZone);
  const second = wallAsUtc - offsetAt(first, timeZone);
  return new Date(second);
}

/** A calendar day moved by a number of days (negative goes back). */
export function addDays(date: string, days: number): string {
  const { year, month, day } = parseDate(date);
  const moved = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1)}-${pad(moved.getUTCDate())}`;
}

/** 1 is Monday and 7 is Sunday. */
export function weekdayOf(date: string): number {
  const { year, month, day } = parseDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The Monday of the week a day belongs to. */
export function startOfWeek(date: string): string {
  return addDays(date, 1 - weekdayOf(date));
}

export function weekDates(date: string): string[] {
  const monday = startOfWeek(date);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** The first day of the month a date belongs to. */
export function startOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  return `${pad(year, 4)}-${pad(month)}-01`;
}

/** Every day shown by a month view: whole Monday-to-Sunday weeks covering the month. */
export function monthGridDates(date: string): string[] {
  const { year, month } = parseDate(date);
  const first = startOfMonth(date);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${pad(year, 4)}-${pad(month)}-${pad(lastDay)}`;
  const start = startOfWeek(first);
  const end = addDays(startOfWeek(last), 6);
  const count =
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}

/** The same day of the previous or next month, kept inside the month when it is shorter. */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parseDate(date);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const clamped = Math.min(day, lastDay);
  return `${pad(target.getUTCFullYear(), 4)}-${pad(target.getUTCMonth() + 1)}-${pad(clamped)}`;
}

export type CalendarViewMode = 'day' | 'week' | 'month';

/** The local days a view shows. */
export function viewDates(view: CalendarViewMode, date: string): string[] {
  if (view === 'day') return [date];
  return view === 'week' ? weekDates(date) : monthGridDates(date);
}

/** The window of instants (`from` included, `to` excluded) the API is asked for. */
export function rangeInstants(
  view: CalendarViewMode,
  date: string,
  timeZone: string,
): { from: string; to: string } {
  const days = viewDates(view, date);
  const first = days[0] ?? date;
  const last = days.at(-1) ?? date;
  return {
    from: zonedInstant(first, 0, timeZone).toISOString(),
    to: zonedInstant(addDays(last, 1), 0, timeZone).toISOString(),
  };
}

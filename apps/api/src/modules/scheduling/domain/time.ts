import { DateTime, IANAZone } from 'luxon';

/**
 * Time zones and daylight saving for scheduling (scheduling, "Time zones and daylight saving").
 *
 * Every appointment is an absolute instant; the location's IANA zone decides how it reads. These
 * functions are the only place that converts between the two. A local wall-clock time can be
 * ordinary, can NOT exist (the hour skipped when clocks go forward) or can happen TWICE (the hour
 * repeated when they go back); the callers must handle all three, so `resolveLocal` reports which.
 */

/** A wall-clock time at a location: a calendar date and `HH:mm`. */
export interface LocalTime {
  date: string;
  time: string;
}

export type LocalResolution =
  | { kind: 'ok'; instant: Date }
  /** Clocks skip this time on this date. */
  | { kind: 'nonexistent' }
  /** Clocks show this time twice; `first` is the earlier instant. */
  | { kind: 'ambiguous'; first: Date; second: Date };

export type Occurrence = 'first' | 'second';

export type OccurrenceChoice =
  { ok: true; instant: Date } | { ok: false; reason: 'nonexistent' | 'ambiguous' };

export interface LocalParts {
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  /** Minutes since local midnight, 0 to 1439. */
  minuteOfDay: number;
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  weekday: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isKnownZone(zone: string): boolean {
  return zone !== '' && IANAZone.isValidZone(zone);
}

function requireZone(zone: string): void {
  if (!isKnownZone(zone)) throw new Error('unknown time zone');
}

/** UTC offset of a zone at an instant, in minutes east of UTC. */
function offsetAt(zone: string, epochMs: number): number {
  return DateTime.fromMillis(epochMs, { zone }).offset;
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(date);
  if (!match) throw new Error('malformed date');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error('malformed date');
  }
  return { year, month, day };
}

/**
 * The instants at which `local` is the wall-clock time of the zone: none (the time is skipped),
 * one, or two (the time is repeated). The offsets in force just before and after the local time are
 * the only candidates, and a candidate is real when the zone is indeed at that offset then.
 */
export function resolveLocal(zone: string, local: LocalTime): LocalResolution {
  requireZone(zone);
  const { year, month, day } = parseDate(local.date);
  const clock = TIME_PATTERN.exec(local.time);
  if (!clock) throw new Error('malformed time');
  const naive = Date.UTC(year, month - 1, day, Number(clock[1]), Number(clock[2]));

  const candidates = new Set([
    offsetAt(zone, naive - 2 * DAY_MS),
    offsetAt(zone, naive + 2 * DAY_MS),
  ]);
  const instants = [...candidates]
    .map((offset) => ({ offset, instant: naive - offset * MINUTE_MS }))
    .filter(({ offset, instant }) => offsetAt(zone, instant) === offset)
    .map(({ instant }) => instant)
    .sort((a, b) => a - b);

  const [first, second] = instants;
  if (first === undefined) return { kind: 'nonexistent' };
  if (second === undefined) return { kind: 'ok', instant: new Date(first) };
  return { kind: 'ambiguous', first: new Date(first), second: new Date(second) };
}

/**
 * Picks the instant a user meant. A time that does not exist is refused; one that repeats needs the
 * user to say which occurrence they want (the system never guesses).
 */
export function chooseOccurrence(
  resolution: LocalResolution,
  occurrence?: Occurrence,
): OccurrenceChoice {
  switch (resolution.kind) {
    case 'ok':
      return { ok: true, instant: resolution.instant };
    case 'nonexistent':
      return { ok: false, reason: 'nonexistent' };
    case 'ambiguous':
      if (occurrence === undefined) return { ok: false, reason: 'ambiguous' };
      return { ok: true, instant: occurrence === 'first' ? resolution.first : resolution.second };
  }
}

/** How an instant reads in the zone: its local date, minute of the day and ISO weekday. */
export function localParts(zone: string, instant: Date): LocalParts {
  requireZone(zone);
  const local = DateTime.fromJSDate(instant, { zone });
  return {
    date: local.toFormat('yyyy-MM-dd'),
    minuteOfDay: local.hour * 60 + local.minute,
    weekday: local.weekday,
  };
}

/** ISO weekday (1 Monday to 7 Sunday) of a calendar date. */
export function weekdayOfDate(date: string): number {
  const { year, month, day } = parseDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/** The instants where a local calendar day starts and where the next one starts. */
export function dayBounds(zone: string, date: string): { start: Date; end: Date } {
  requireZone(zone);
  parseDate(date);
  const start = DateTime.fromISO(date, { zone }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).startOf('day').toJSDate() };
}

/**
 * The same local wall-clock time `days` calendar days later. A time that does not exist on the
 * target day moves forward to the first valid time after the gap; one that repeats resolves to its
 * first occurrence.
 */
export function addLocalDays(zone: string, instant: Date, days: number): Date {
  requireZone(zone);
  return DateTime.fromJSDate(instant, { zone }).plus({ days }).toJSDate();
}

/** Whole minutes of elapsed time between two instants (a duration is never a wall-clock difference). */
export function elapsedMinutes(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MINUTE_MS);
}

/**
 * The instant of a minute of a local day (0 to 1440; 1440 is the start of the next day). Used to
 * turn working hours, which are minutes in the location's zone, into instants. A minute that is
 * skipped by daylight saving time maps to the moment the clocks jump (so an interval never starts
 * or ends in thin air); a repeated minute maps to its first occurrence unless `prefer` says second.
 */
export function instantAtLocalMinute(
  zone: string,
  date: string,
  minute: number,
  prefer: Occurrence = 'first',
): Date {
  if (minute >= 1440) return dayBounds(zone, date).end;
  const hours = String(Math.floor(minute / 60)).padStart(2, '0');
  const minutes = String(minute % 60).padStart(2, '0');
  const resolution = resolveLocal(zone, { date, time: `${hours}:${minutes}` });
  const choice = chooseOccurrence(resolution, prefer);
  if (choice.ok) return choice.instant;

  // Skipped by the clocks: walk forward from the last instant that still showed an earlier time
  // until the offset changes. The gap is at most a couple of hours.
  const { year, month, day } = parseDate(date);
  const naive = Date.UTC(year, month - 1, day, 0, minute);
  const before = offsetAt(zone, naive - 2 * DAY_MS);
  let instant =
    naive - Math.max(before, offsetAt(zone, naive + 2 * DAY_MS)) * MINUTE_MS - 3 * 60 * MINUTE_MS;
  for (let step = 0; step < 24 * 60 && offsetAt(zone, instant) === before; step += 1) {
    instant += MINUTE_MS;
  }
  return new Date(instant);
}

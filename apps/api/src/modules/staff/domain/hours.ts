export interface HoursEntry {
  locationId: string;
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  weekday: number;
  /** Minutes since local midnight at the location. */
  startMinute: number;
  endMinute: number;
}

export interface HoursProblem {
  index: number;
  path: string;
  i18nKey: string;
}

const MINUTES_PER_DAY = 1440;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** "09:30" (or "24:00" for the end of the day) as minutes since midnight. */
export function parseClock(text: string): number {
  const [hours = '0', minutes = '0'] = text.split(':');
  return Number(hours) * 60 + Number(minutes);
}

export function formatClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Offset of a time zone from UTC, in minutes, at a given instant (daylight saving time included).
 * Argentina has none today; the function is for any zone a location may have.
 */
export function zoneOffsetMinutes(timeZone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(at);
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  if (!match?.[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? '0');
  return match[1] === '-' ? -minutes : minutes;
}

function modulo(value: number): number {
  return ((value % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
}

/**
 * Checks a whole weekly schedule (staff-professionals, "Weekly working hours per location").
 *
 * - Every interval needs an end after its start, in the location's own time.
 * - Intervals must not overlap, across locations too. Intervals at locations with different time
 *   zones are compared as ABSOLUTE instants: each one is placed on a week measured in UTC, using
 *   the offset of its location, so 09:00 in Buenos Aires and 14:00 in Madrid can be the same moment.
 *   The week wraps around, so Sunday night and Monday morning are neighbors.
 * - Touching intervals (one ends when the next starts) are fine.
 *
 * `offsets` maps a location id to its offset in minutes at the reference instant the caller chose.
 * A recurring schedule has no single instant; the caller uses "now", which is exact for zones
 * without daylight saving time and right for the current season for the rest.
 */
export function findHoursProblems(
  entries: readonly HoursEntry[],
  offsets: ReadonlyMap<string, number>,
): HoursProblem[] {
  const problems: HoursProblem[] = [];
  const placed: { index: number; start: number; length: number }[] = [];

  entries.forEach((item, index) => {
    const offset = offsets.get(item.locationId);
    if (offset === undefined) {
      problems.push({
        index,
        path: `hours.${String(index)}.locationId`,
        i18nKey: 'staff.hours.location_unknown',
      });
      return;
    }
    if (item.endMinute <= item.startMinute) {
      problems.push({
        index,
        path: `hours.${String(index)}.end`,
        i18nKey: 'staff.hours.end_before_start',
      });
      return;
    }
    const length = item.endMinute - item.startMinute;
    const start = modulo((item.weekday - 1) * MINUTES_PER_DAY + item.startMinute - offset);

    const clashes = placed.some(
      (other) => modulo(start - other.start) < other.length || modulo(other.start - start) < length,
    );
    if (clashes) {
      problems.push({ index, path: `hours.${String(index)}`, i18nKey: 'staff.hours.overlap' });
      return;
    }
    placed.push({ index, start, length });
  });

  return problems;
}

/**
 * The audit period is typed as calendar days but sent as instants: a day starts at midnight of the
 * organization's time zone, not of the browser's, so a report means the same thing for everyone.
 */

function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((candidate) => candidate.type === type)?.value);
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

/** The instant a calendar day (`YYYY-MM-DD`) begins in a time zone. */
export function startOfDayIso(day: string, timeZone: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const wallAsUtc = Date.UTC(year, month - 1, date);
  // The offset can differ between the guess and the real instant around a clock change: settle it.
  let instant = new Date(wallAsUtc - offsetMinutes(new Date(wallAsUtc), timeZone) * 60_000);
  instant = new Date(wallAsUtc - offsetMinutes(instant, timeZone) * 60_000);
  return instant.toISOString();
}

/** The end of the period is exclusive: the start of the day after the last one chosen. */
export function endOfDayIso(day: string, timeZone: string): string {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
  return startOfDayIso(next, timeZone);
}

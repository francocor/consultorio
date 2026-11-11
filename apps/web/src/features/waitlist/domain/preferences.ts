import type { WaitlistTimeRange } from '@consultorio/contracts';

/** The two parts of the day reception picks most often. */
export const MORNING: WaitlistTimeRange = { from: '08:00', to: '12:00' };
export const AFTERNOON: WaitlistTimeRange = { from: '12:00', to: '18:00' };

/** Monday (1) to Sunday (7). */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The name of a weekday in Spanish. 12 May 2031 is a Monday, so day `n` is the `n`th of that week. */
export function weekdayName(day: number, width: 'short' | 'long'): string {
  const name = new Intl.DateTimeFormat('es-AR', { weekday: width, timeZone: 'UTC' }).format(
    new Date(Date.UTC(2031, 4, 11 + day)),
  );
  // `short` comes with a dot in some runtimes ("lun."); the screens write it without.
  return name.replace(/\.$/, '');
}

/** The chosen days in week order, or null when any day will do. */
export function describeDays(days: readonly number[]): string | null {
  if (days.length === 0) return null;
  return [...days]
    .sort((a, b) => a - b)
    .map((day) => weekdayName(day, 'short'))
    .join(', ');
}

/** Adds the day to the choice, or takes it away when it is there; always in week order. */
export function toggleDay(days: readonly number[], day: number): number[] {
  const next = days.includes(day) ? days.filter((chosen) => chosen !== day) : [...days, day];
  return next.sort((a, b) => a - b);
}

/** The ranges as text, or null when any time will do. */
export function describeRanges(ranges: readonly WaitlistTimeRange[]): string | null {
  if (ranges.length === 0) return null;
  return ranges.map((range) => `${range.from} a ${range.to}`).join(', ');
}

/** What is wrong with a range being typed: a limit is missing, or it does not end after it starts. */
export function rangeProblem(range: { from: string; to: string }): 'empty' | 'order' | null {
  if (range.from === '' || range.to === '') return 'empty';
  return range.from < range.to ? null : 'order';
}

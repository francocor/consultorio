import { DateTime } from 'luxon';

/**
 * The calendar of the billing (subscriptions, "Billing cycle and statements"). A billing period is a
 * calendar month, and a day is a day of that month, both in the zone of the country the product is
 * sold in (Argentina, the only country today). One fixed zone and not the zone of each organization:
 * the platform bills every organization on the same calendar, so a statement, a quota and a
 * proration never disagree about where a month starts.
 */
export const BILLING_ZONE = 'America/Argentina/Buenos_Aires';

const PERIOD_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `YYYY-MM`: the period an instant falls in. */
export function periodOf(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: BILLING_ZONE }).toFormat('yyyy-MM');
}

/** `YYYY-MM-DD`: the billing day an instant falls in. */
export function dayOf(instant: Date): string {
  return DateTime.fromJSDate(instant, { zone: BILLING_ZONE }).toFormat('yyyy-MM-dd');
}

export function isPeriod(value: string): boolean {
  return PERIOD_PATTERN.test(value);
}

export interface PeriodBounds {
  /** The first instant of the period. */
  start: Date;
  /** The first instant after the period: the start of the next one. */
  end: Date;
  /** How many days it has. */
  days: number;
}

export function periodBounds(period: string): PeriodBounds {
  if (!isPeriod(period)) throw new RangeError('A period is written YYYY-MM.');
  const start = DateTime.fromFormat(period, 'yyyy-MM', { zone: BILLING_ZONE });
  const end = start.plus({ months: 1 });
  return {
    start: start.toJSDate(),
    end: end.toJSDate(),
    days: Math.round(end.diff(start, 'days').days),
  };
}

/** The period after this one. */
export function nextPeriod(period: string): string {
  return periodOf(periodBounds(period).end);
}

/** The period before this one. */
export function previousPeriod(period: string): string {
  return periodOf(new Date(periodBounds(period).start.getTime() - 1));
}

/** The first instant after the period an instant falls in. */
export function endOfPeriodOf(instant: Date): Date {
  return periodBounds(periodOf(instant)).end;
}

/** Whole days between two billing days (`YYYY-MM-DD`), the end excluded. */
export function daysBetween(from: string, to: string): number {
  const a = DateTime.fromFormat(from, 'yyyy-MM-dd', { zone: 'utc' });
  const b = DateTime.fromFormat(to, 'yyyy-MM-dd', { zone: 'utc' });
  return Math.round(b.diff(a, 'days').days);
}

/** How many billing days of the period are left, counting the day of `instant` itself. */
export function daysLeftIncludingToday(instant: Date): number {
  const bounds = periodBounds(periodOf(instant));
  return daysBetween(dayOf(instant), dayOf(bounds.end));
}

/** The days of a period, as `YYYY-MM-DD`, in order. */
export function daysOfPeriod(period: string): string[] {
  const { start, days } = periodBounds(period);
  const first = DateTime.fromJSDate(start, { zone: BILLING_ZONE });
  return Array.from({ length: days }, (_, index) =>
    first.plus({ days: index }).toFormat('yyyy-MM-dd'),
  );
}

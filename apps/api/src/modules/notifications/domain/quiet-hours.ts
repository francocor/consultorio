import { DateTime } from 'luxon';

/**
 * Quiet hours (spec "Automatic reminders"; design 5.2). By default nothing automated is sent
 * between 21:00 and 08:00 in the zone of the location. A reminder due inside the window moves to
 * its end when that still comes before the appointment; otherwise it is skipped and reception is
 * told. The window is read in the location's IANA zone, so a day with a clock change still ends
 * quiet hours at the real 08:00.
 *
 * Exempt (the callers never ask): confirmations that answer an action, one-time codes and
 * transactional email.
 */

export interface QuietWindow {
  /** `HH:MM`, 24-hour. */
  start: string;
  end: string;
}

export type QuietDecision = { kind: 'send'; at: Date } | { kind: 'skip' };

function minutesOf(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Equal start and end is "no quiet hours": a window of zero length. */
function isDisabled(quiet: QuietWindow): boolean {
  return minutesOf(quiet.start) === minutesOf(quiet.end);
}

export function isInQuietHours(instant: Date, timeZone: string, quiet: QuietWindow): boolean {
  if (isDisabled(quiet)) return false;
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  const minute = local.hour * 60 + local.minute;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The first instant at or after `from` when the wall clock of the zone shows `clock`. */
function nextLocalTime(from: Date, timeZone: string, clock: string): Date {
  const minutes = minutesOf(clock);
  const local = DateTime.fromJSDate(from, { zone: timeZone });
  // Setting the wall clock (not adding minutes to midnight) keeps a day with a clock change right.
  const target = local.set({
    hour: Math.floor(minutes / 60),
    minute: minutes % 60,
    second: 0,
    millisecond: 0,
  });
  return (target.toMillis() > local.toMillis() ? target : target.plus({ days: 1 })).toJSDate();
}

export function applyQuietHours(input: {
  /** When the reminder falls due. */
  due: Date;
  startsAt: Date;
  timeZone: string;
  quiet: QuietWindow;
}): QuietDecision {
  if (!isInQuietHours(input.due, input.timeZone, input.quiet)) {
    return { kind: 'send', at: input.due };
  }
  const end = nextLocalTime(input.due, input.timeZone, input.quiet.end);
  return end.getTime() < input.startsAt.getTime() ? { kind: 'send', at: end } : { kind: 'skip' };
}

import { addDays, zonedInstant } from '../../../../shared/ui/calendar/zoned-time.js';

export interface BlockFormTimes {
  startDate: string;
  startTime: string;
  /** Empty means the same day as the start. */
  endDate: string;
  endTime: string;
  allDay: boolean;
}

export type BlockRange =
  { ok: true; startsAt: string; endsAt: string } | { ok: false; error: 'missing' | 'order' };

const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(time: string): number | null {
  const match = clock.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * The instants a block covers, read in the time zone of the location it belongs to: a block "from
 * 9:00 to 13:30" is those hours there, whatever the device says. A whole-day block runs from the
 * midnight that starts its first day to the midnight that ends its last.
 */
export function blockRange(times: BlockFormTimes, timeZone: string): BlockRange {
  if (times.startDate === '') return { ok: false, error: 'missing' };
  const endDate = times.endDate === '' ? times.startDate : times.endDate;

  let startsAt: Date;
  let endsAt: Date;
  if (times.allDay) {
    startsAt = zonedInstant(times.startDate, 0, timeZone);
    endsAt = zonedInstant(addDays(endDate, 1), 0, timeZone);
  } else {
    const start = minutesOf(times.startTime);
    const end = minutesOf(times.endTime);
    if (start === null || end === null) return { ok: false, error: 'missing' };
    startsAt = zonedInstant(times.startDate, start, timeZone);
    endsAt = zonedInstant(endDate, end, timeZone);
  }
  if (!(endsAt.getTime() > startsAt.getTime())) return { ok: false, error: 'order' };
  return { ok: true, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

/** Whether an appointment falls inside a block (touching at an end is not overlapping). */
export function overlapsRange(
  appointment: { startsAt: string; endsAt: string },
  range: { startsAt: string; endsAt: string },
): boolean {
  return (
    Date.parse(appointment.startsAt) < Date.parse(range.endsAt) &&
    Date.parse(appointment.endsAt) > Date.parse(range.startsAt)
  );
}

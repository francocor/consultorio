import type { PublicSlotDto } from '@consultorio/contracts';

import { formatTime, LOCALE } from '../../../shared/lib/format.js';

const DAY_MS = 86_400_000;

export interface SlotDay {
  /** The local date, `YYYY-MM-DD`. */
  date: string;
  slots: PublicSlotDto[];
}

/** Groups slots by the local date of their start, keeping their order. */
export function groupByDay(slots: readonly PublicSlotDto[]): SlotDay[] {
  const days: SlotDay[] = [];
  for (const slot of slots) {
    const last = days.at(-1);
    if (last?.date === slot.date) last.slots.push(slot);
    else days.push({ date: slot.date, slots: [slot] });
  }
  return days;
}

/** A calendar date as a date at noon UTC, so no time zone moves it a day. */
function calendarDay(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/** `lun 12 may`: the label of a day button. */
export function dayLabel(date: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).formatToParts(calendarDay(date));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('weekday').replace('.', '')} ${part('day')} ${part('month').replace('.', '')}`;
}

/** `lunes 12 de mayo`: a day in a sentence. */
export function longDayLabel(date: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
    .format(calendarDay(date))
    .replace(',', '');
}

/** `10:00` in the zone of the location. */
export function slotLabel(startsAt: string, timeZone: string): string {
  return formatTime(startsAt, { timeZone });
}

/** `Buenos Aires (GMT-3)`: the zone the times are shown in. */
export function zoneLabel(timeZone: string, at: Date): string {
  const city = (timeZone.split('/').at(-1) ?? timeZone).replaceAll('_', ' ');
  const offset =
    new Intl.DateTimeFormat(LOCALE, { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  return `${city} (${offset})`;
}

/** Today's date at the location, `YYYY-MM-DD`. */
export function todayIn(timeZone: string, now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A calendar date moved by whole days. */
export function addDays(date: string, days: number): string {
  return new Date(calendarDay(date).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

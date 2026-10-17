import type { WaitlistCallReason, WaitlistTimeRange } from '@consultorio/contracts';
import { DateTime } from 'luxon';

/**
 * Matching a freed slot to the entries that wait (waitlist, "Matching freed slots"). Pure: it
 * answers from the facts it is given, so every rule is proven without a database. The caller finds
 * the facts (the entries, the patients who are busy, the patients who were already offered the
 * slot) and acts on the answer.
 */

/** An entry as matching needs it. */
export interface WaitingEntry {
  id: string;
  patientId: string;
  professionalId: string | null;
  locationId: string | null;
  /** 1 (Monday) to 7 (Sunday); empty means any day. */
  weekdays: readonly number[];
  /** Local `HH:MM` ranges; empty means any time. */
  timeRanges: readonly WaitlistTimeRange[];
  /** Local dates, both ends included. */
  earliestDate: string | null;
  latestDate: string | null;
  /** The organization's override: a higher level goes first. */
  priority: number;
  /** When the patient started to wait: the older the earlier. */
  waitingSince: Date;
}

/** A range of time somebody gave back, and where it is. */
export interface FreedSlot {
  professionalId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  /** The zone of the location: preferences are read in it. */
  timeZone: string;
}

function minutesOf(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/**
 * Whether the slot is one the entry accepts: the professional and the location it names, a day and
 * a part of the day it can come, and a date inside its range. All of it in the local time of the
 * location. The whole slot has to fit inside one time range, and a slot that crosses midnight fits
 * none.
 */
export function fitsPreferences(entry: WaitingEntry, slot: FreedSlot): boolean {
  if (entry.professionalId !== null && entry.professionalId !== slot.professionalId) return false;
  if (entry.locationId !== null && entry.locationId !== slot.locationId) return false;

  const start = DateTime.fromJSDate(slot.startsAt, { zone: slot.timeZone });
  const end = DateTime.fromJSDate(slot.endsAt, { zone: slot.timeZone });
  const date = start.toISODate();
  if (date === null) return false;
  if (entry.earliestDate !== null && date < entry.earliestDate) return false;
  if (entry.latestDate !== null && date > entry.latestDate) return false;
  if (entry.weekdays.length > 0 && !entry.weekdays.includes(start.weekday)) return false;

  if (entry.timeRanges.length > 0) {
    if (end.toISODate() !== date) return false;
    const from = start.hour * 60 + start.minute;
    const to = end.hour * 60 + end.minute;
    return entry.timeRanges.some(
      (range) => minutesOf(range.from) <= from && to <= minutesOf(range.to),
    );
  }
  return true;
}

/**
 * The order offers go out: the organization's override first (a higher level before a lower one),
 * then the longest wait, then the id so that a tie is always broken the same way. The input is
 * left alone.
 */
export function orderEntries<T extends Pick<WaitingEntry, 'id' | 'priority' | 'waitingSince'>>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(
    (a, b) =>
      b.priority - a.priority ||
      a.waitingSince.getTime() - b.waitingSince.getTime() ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The entries a freed slot can be offered to, in the order they are offered: the ones whose
 * preferences it fits, without the patients who have another appointment overlapping it and the
 * ones who were already offered it. A patient with two fitting entries comes up once, through the
 * entry that has waited longer (or has the higher override).
 */
export function entriesForSlot(input: {
  entries: readonly WaitingEntry[];
  slot: FreedSlot;
  busyPatients: ReadonlySet<string>;
  offeredPatients: ReadonlySet<string>;
}): WaitingEntry[] {
  const seen = new Set<string>();
  const result: WaitingEntry[] = [];
  for (const candidate of orderEntries(input.entries)) {
    if (!fitsPreferences(candidate, input.slot)) continue;
    if (input.busyPatients.has(candidate.patientId)) continue;
    if (input.offeredPatients.has(candidate.patientId)) continue;
    if (seen.has(candidate.patientId)) continue;
    seen.add(candidate.patientId);
    result.push(candidate);
  }
  return result;
}

// Timing ---------------------------------------------------------------------------------------

/** An offer that would last less than this cannot be answered, so it is not sent. */
export const MIN_OFFER_LIFE_MINUTES = 5;

export interface QuietWindow {
  /** `HH:MM`, 24-hour. */
  start: string;
  end: string;
}

function inQuietHours(instant: Date, timeZone: string, quiet: QuietWindow): boolean {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  // Equal start and end is "no quiet hours".
  if (start === end) return false;
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  const minute = local.hour * 60 + local.minute;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** The first instant after `from` when the wall clock of the zone shows `clock`. */
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

export type OfferTiming =
  | { kind: 'send'; sendAt: Date; expiresAt: Date }
  | { kind: 'manual'; reason: Extract<WaitlistCallReason, 'slot_too_close' | 'quiet_hours'> };

/**
 * When an offer for a slot goes out and when it stops being valid (waitlist, "Offers with expiry",
 * "Opt-out and consent in offers").
 *
 * - An offer due inside quiet hours waits for their end.
 * - An offer lasts the organization's window, but never past the moment that still leaves the
 *   minimum lead time before the slot starts. The patient needs that time to come.
 * - If that leaves less than five minutes, nothing is sent: reception sees the slot and calls. The
 *   reason is the lead time, or quiet hours when it was the wait for their end that used it up.
 */
export function offerTiming(input: {
  now: Date;
  startsAt: Date;
  minLeadMinutes: number;
  offerWindowMinutes: number;
  quiet: QuietWindow;
  timeZone: string;
}): OfferTiming {
  const deferred = inQuietHours(input.now, input.timeZone, input.quiet);
  const sendAt = deferred ? nextLocalTime(input.now, input.timeZone, input.quiet.end) : input.now;
  const lastMoment = input.startsAt.getTime() - input.minLeadMinutes * 60_000;
  const expiresAt = Math.min(sendAt.getTime() + input.offerWindowMinutes * 60_000, lastMoment);
  if (expiresAt - sendAt.getTime() < MIN_OFFER_LIFE_MINUTES * 60_000) {
    return { kind: 'manual', reason: deferred ? 'quiet_hours' : 'slot_too_close' };
  }
  return { kind: 'send', sendAt, expiresAt: new Date(expiresAt) };
}

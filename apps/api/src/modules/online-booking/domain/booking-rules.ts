/**
 * Pure rules of the public booking flow (online-booking, "Availability and booking constraints").
 */

/** Letters and digits without the look-alikes 0, 1, l and o: 32 symbols, so a byte maps without bias. */
export const SLUG_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
export const SLUG_LENGTH = 12;

/** A booking-link slug from random bytes: 12 symbols of 5 bits, 60 bits in all. */
export function slugFromBytes(bytes: Uint8Array): string {
  if (bytes.length < SLUG_LENGTH) throw new Error('Not enough random bytes for a slug');
  let slug = '';
  for (let index = 0; index < SLUG_LENGTH; index += 1) {
    slug += SLUG_ALPHABET.charAt((bytes[index] ?? 0) % SLUG_ALPHABET.length);
  }
  return slug;
}

export interface BookableWindow {
  now: Date;
  /** The earliest bookable slot starts this many hours from now. */
  minLeadHours: number;
  /** The furthest bookable day, in days from now. */
  horizonDays: number;
}

/** Keeps the slots that start no sooner than the lead time and no later than the horizon. */
export function filterBookableSlots<T extends { startsAt: string }>(
  slots: readonly T[],
  window: BookableWindow,
): T[] {
  const earliest = window.now.getTime() + window.minLeadHours * 3_600_000;
  const latest = window.now.getTime() + window.horizonDays * 86_400_000;
  return slots.filter((slot) => {
    const start = Date.parse(slot.startsAt);
    return start >= earliest && start <= latest;
  });
}

/** The calendar date (`YYYY-MM-DD`) an instant falls on in a time zone. */
export function localDateOf(timeZone: string, instant: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** The optional daily cap of online bookings per professional is used up. */
export function dailyCapReached(cap: number | null, booked: number): boolean {
  return cap !== null && booked >= cap;
}

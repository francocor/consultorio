import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  entriesForSlot,
  fitsPreferences,
  offerTiming,
  orderEntries,
  type FreedSlot,
  type WaitingEntry,
} from './matching.js';

const BA = 'America/Argentina/Buenos_Aires';

/** Thursday 2031-05-15, 10:00 to 10:30 in Buenos Aires (UTC-3). */
const slot: FreedSlot = {
  professionalId: 'p1',
  locationId: 'l1',
  startsAt: new Date('2031-05-15T13:00:00Z'),
  endsAt: new Date('2031-05-15T13:30:00Z'),
  timeZone: BA,
};

let counter = 0;
function entry(overrides: Partial<WaitingEntry> = {}): WaitingEntry {
  counter += 1;
  return {
    id: `entry-${String(counter)}`,
    patientId: `patient-${String(counter)}`,
    professionalId: null,
    locationId: null,
    weekdays: [],
    timeRanges: [],
    earliestDate: null,
    latestDate: null,
    priority: 0,
    waitingSince: new Date('2031-04-01T12:00:00Z'),
    ...overrides,
  };
}

describe('fitsPreferences', () => {
  it('accepts an entry with no preferences', () => {
    expect(fitsPreferences(entry(), slot)).toBe(true);
  });

  it('wants the professional it names, and any professional when it names none', () => {
    expect(fitsPreferences(entry({ professionalId: 'p1' }), slot)).toBe(true);
    expect(fitsPreferences(entry({ professionalId: 'p2' }), slot)).toBe(false);
  });

  it('wants the location it names, and any location when it names none', () => {
    expect(fitsPreferences(entry({ locationId: 'l1' }), slot)).toBe(true);
    expect(fitsPreferences(entry({ locationId: 'l2' }), slot)).toBe(false);
  });

  it('reads the weekday in the zone of the location (1 is Monday)', () => {
    expect(fitsPreferences(entry({ weekdays: [4] }), slot)).toBe(true);
    expect(fitsPreferences(entry({ weekdays: [1, 2, 3, 5] }), slot)).toBe(false);
    // 23:00 on Thursday in Buenos Aires is already Friday in UTC.
    const late: FreedSlot = {
      ...slot,
      startsAt: new Date('2031-05-16T02:00:00Z'),
      endsAt: new Date('2031-05-16T02:30:00Z'),
    };
    expect(fitsPreferences(entry({ weekdays: [4] }), late)).toBe(true);
    expect(fitsPreferences(entry({ weekdays: [5] }), late)).toBe(false);
  });

  it('wants the whole slot inside one of the time ranges', () => {
    const morning = { from: '08:00', to: '12:00' };
    const afternoon = { from: '14:00', to: '18:00' };

    expect(fitsPreferences(entry({ timeRanges: [morning] }), slot)).toBe(true);
    expect(fitsPreferences(entry({ timeRanges: [afternoon] }), slot)).toBe(false);
    expect(fitsPreferences(entry({ timeRanges: [afternoon, morning] }), slot)).toBe(true);

    const straddling: FreedSlot = {
      ...slot,
      startsAt: new Date('2031-05-15T14:45:00Z'),
      endsAt: new Date('2031-05-15T15:15:00Z'),
    };
    // 11:45 to 12:15 local starts inside the morning but does not end there.
    expect(fitsPreferences(entry({ timeRanges: [morning] }), straddling)).toBe(false);
    // The range may end exactly where the slot ends.
    expect(fitsPreferences(entry({ timeRanges: [{ from: '10:00', to: '10:30' }] }), slot)).toBe(
      true,
    );
  });

  it('never fits a slot that crosses midnight into a range of the day', () => {
    const overnight: FreedSlot = {
      ...slot,
      startsAt: new Date('2031-05-16T02:45:00Z'),
      endsAt: new Date('2031-05-16T03:15:00Z'),
    };

    expect(
      fitsPreferences(entry({ timeRanges: [{ from: '22:00', to: '23:59' }] }), overnight),
    ).toBe(false);
    expect(fitsPreferences(entry(), overnight)).toBe(true);
  });

  it('includes both ends of the date range, read as local dates', () => {
    expect(fitsPreferences(entry({ earliestDate: '2031-05-15' }), slot)).toBe(true);
    expect(fitsPreferences(entry({ latestDate: '2031-05-15' }), slot)).toBe(true);
    expect(fitsPreferences(entry({ earliestDate: '2031-05-16' }), slot)).toBe(false);
    expect(fitsPreferences(entry({ latestDate: '2031-05-14' }), slot)).toBe(false);
    // 23:00 on the 15th in Buenos Aires is the 16th in UTC, but it is still the 15th for the patient.
    const late: FreedSlot = {
      ...slot,
      startsAt: new Date('2031-05-16T02:00:00Z'),
      endsAt: new Date('2031-05-16T02:30:00Z'),
    };
    expect(fitsPreferences(entry({ latestDate: '2031-05-15' }), late)).toBe(true);
  });
});

describe('orderEntries', () => {
  it('puts the longest wait first', () => {
    const old = entry({ waitingSince: new Date('2031-03-01T00:00:00Z') });
    const recent = entry({ waitingSince: new Date('2031-04-20T00:00:00Z') });
    const middle = entry({ waitingSince: new Date('2031-04-01T00:00:00Z') });

    expect(orderEntries([recent, old, middle]).map((row) => row.id)).toEqual([
      old.id,
      middle.id,
      recent.id,
    ]);
  });

  it('puts an override before the wait, the higher level first', () => {
    const waited = entry({ waitingSince: new Date('2031-01-01T00:00:00Z') });
    const priority = entry({ priority: 1, waitingSince: new Date('2031-04-01T00:00:00Z') });
    const urgent = entry({ priority: 2, waitingSince: new Date('2031-04-20T00:00:00Z') });
    const sameLevel = entry({ priority: 1, waitingSince: new Date('2031-02-01T00:00:00Z') });

    expect(orderEntries([waited, priority, urgent, sameLevel]).map((row) => row.id)).toEqual([
      urgent.id,
      sameLevel.id,
      priority.id,
      waited.id,
    ]);
  });

  it('breaks a tie the same way every time and leaves its input alone', () => {
    const since = new Date('2031-04-01T00:00:00Z');
    const b = entry({ id: 'b', waitingSince: since });
    const a = entry({ id: 'a', waitingSince: since });
    const input = [b, a];

    expect(orderEntries(input).map((row) => row.id)).toEqual(['a', 'b']);
    expect(input.map((row) => row.id)).toEqual(['b', 'a']);
  });
});

describe('entriesForSlot', () => {
  it('lists the entries that fit, in the order they are offered', () => {
    const morning = entry({
      timeRanges: [{ from: '08:00', to: '12:00' }],
      waitingSince: new Date('2031-04-10T00:00:00Z'),
    });
    const afternoon = entry({
      timeRanges: [{ from: '14:00', to: '18:00' }],
      waitingSince: new Date('2031-01-01T00:00:00Z'),
    });
    const anyTime = entry({ waitingSince: new Date('2031-03-01T00:00:00Z') });

    const result = entriesForSlot({
      entries: [morning, afternoon, anyTime],
      slot,
      busyPatients: new Set(),
      offeredPatients: new Set(),
    });

    expect(result.map((row) => row.id)).toEqual([anyTime.id, morning.id]);
  });

  it('skips a patient who has another appointment at that time', () => {
    const busy = entry({ waitingSince: new Date('2031-01-01T00:00:00Z') });
    const free = entry({ waitingSince: new Date('2031-02-01T00:00:00Z') });

    const result = entriesForSlot({
      entries: [busy, free],
      slot,
      busyPatients: new Set([busy.patientId]),
      offeredPatients: new Set(),
    });

    expect(result.map((row) => row.id)).toEqual([free.id]);
  });

  it('skips a patient who was already offered the slot, whichever entry they use', () => {
    const first = entry({ patientId: 'same', waitingSince: new Date('2031-01-01T00:00:00Z') });
    const second = entry({ patientId: 'same', waitingSince: new Date('2031-02-01T00:00:00Z') });
    const other = entry({ waitingSince: new Date('2031-03-01T00:00:00Z') });

    const result = entriesForSlot({
      entries: [first, second, other],
      slot,
      busyPatients: new Set(),
      offeredPatients: new Set(['same']),
    });

    expect(result.map((row) => row.id)).toEqual([other.id]);
  });

  it('offers a patient with two fitting entries only once, through the one that waited longer', () => {
    const older = entry({ patientId: 'twice', waitingSince: new Date('2031-01-01T00:00:00Z') });
    const newer = entry({ patientId: 'twice', waitingSince: new Date('2031-02-01T00:00:00Z') });

    const result = entriesForSlot({
      entries: [newer, older],
      slot,
      busyPatients: new Set(),
      offeredPatients: new Set(),
    });

    expect(result.map((row) => row.id)).toEqual([older.id]);
  });

  it('never returns an entry whose preferences the slot breaks (property)', () => {
    const utc = 'UTC';
    const minutesOf = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
    const clock = fc
      .integer({ min: 0, max: 23 * 60 + 58 })
      .map(
        (minute) =>
          `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
      );
    const range = fc
      .tuple(clock, clock)
      .filter(([from, to]) => from < to)
      .map(([from, to]) => ({ from, to }));
    const day = fc
      .integer({ min: 0, max: 60 })
      .map((offset) => new Date(Date.UTC(2031, 4, 1 + offset)).toISOString().slice(0, 10));
    const waiting = fc.record({
      id: fc.uuid(),
      patientId: fc.uuid(),
      professionalId: fc.option(fc.constantFrom('p1', 'p2'), { nil: null }),
      locationId: fc.option(fc.constantFrom('l1', 'l2'), { nil: null }),
      weekdays: fc.array(fc.integer({ min: 1, max: 7 }), { maxLength: 4 }),
      timeRanges: fc.array(range, { maxLength: 3 }),
      earliestDate: fc.option(day, { nil: null }),
      latestDate: fc.option(day, { nil: null }),
      priority: fc.integer({ min: 0, max: 2 }),
      waitingSince: fc.date({ min: new Date('2031-01-01'), max: new Date('2031-04-30') }),
    });
    const freed = fc.record({
      professionalId: fc.constantFrom('p1', 'p2'),
      locationId: fc.constantFrom('l1', 'l2'),
      startsAt: fc.date({
        min: new Date('2031-05-01T00:00:00Z'),
        max: new Date('2031-06-30T00:00:00Z'),
      }),
      minutes: fc.constantFrom(15, 30, 45, 60),
    });

    fc.assert(
      fc.property(fc.array(waiting, { maxLength: 8 }), freed, (entries, spec) => {
        const free: FreedSlot = {
          professionalId: spec.professionalId,
          locationId: spec.locationId,
          startsAt: spec.startsAt,
          endsAt: new Date(spec.startsAt.getTime() + spec.minutes * 60_000),
          timeZone: utc,
        };
        const offered = entriesForSlot({
          entries,
          slot: free,
          busyPatients: new Set(),
          offeredPatients: new Set(),
        });

        for (const row of offered) {
          const date = free.startsAt.toISOString().slice(0, 10);
          const weekday = free.startsAt.getUTCDay() === 0 ? 7 : free.startsAt.getUTCDay();
          const start = free.startsAt.getUTCHours() * 60 + free.startsAt.getUTCMinutes();
          const end = start + spec.minutes;
          if (row.professionalId !== null) expect(row.professionalId).toBe(free.professionalId);
          if (row.locationId !== null) expect(row.locationId).toBe(free.locationId);
          if (row.weekdays.length > 0) expect(row.weekdays).toContain(weekday);
          if (row.earliestDate !== null) expect(date >= row.earliestDate).toBe(true);
          if (row.latestDate !== null) expect(date <= row.latestDate).toBe(true);
          if (row.timeRanges.length > 0) {
            expect(
              row.timeRanges.some(
                (candidate) => minutesOf(candidate.from) <= start && end <= minutesOf(candidate.to),
              ),
            ).toBe(true);
          }
        }
        // And every entry that was left out had a reason: nothing that fits is lost.
        const kept = new Set(offered.map((row) => row.id));
        const patients = new Set(offered.map((row) => row.patientId));
        expect(patients.size).toBe(offered.length);
        for (const row of entries) {
          if (kept.has(row.id)) continue;
          const sameWait = offered.some((other) => other.patientId === row.patientId);
          expect(sameWait || !fitsPreferences(row, free)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('offerTiming', () => {
  const quiet = { start: '21:00', end: '08:00' };
  const base = { minLeadMinutes: 60, offerWindowMinutes: 30, quiet, timeZone: BA };
  const at = (iso: string) => new Date(iso);
  const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

  it('sends at once and lets the offer last the whole window when the slot is far enough', () => {
    const now = at('2031-05-15T14:00:00Z'); // 11:00 local
    const startsAt = at('2031-05-16T14:00:00Z');

    expect(offerTiming({ ...base, now, startsAt })).toEqual({
      kind: 'send',
      sendAt: now,
      expiresAt: plus(now, 30),
    });
  });

  it('shortens the offer so that the minimum lead time is left before the start', () => {
    const now = at('2031-05-15T14:00:00Z');

    // 90 minutes away: the 30 minute window still leaves exactly the hour.
    expect(offerTiming({ ...base, now, startsAt: plus(now, 90) })).toEqual({
      kind: 'send',
      sendAt: now,
      expiresAt: plus(now, 30),
    });
    // 75 minutes away: only 15 minutes remain before the last moment to answer.
    expect(offerTiming({ ...base, now, startsAt: plus(now, 75) })).toEqual({
      kind: 'send',
      sendAt: now,
      expiresAt: plus(now, 15),
    });
  });

  it('leaves the slot to reception when it starts sooner than the minimum lead time', () => {
    const now = at('2031-05-15T14:00:00Z');

    expect(offerTiming({ ...base, now, startsAt: plus(now, 30) })).toEqual({
      kind: 'manual',
      reason: 'slot_too_close',
    });
    expect(offerTiming({ ...base, now, startsAt: plus(now, 60) })).toEqual({
      kind: 'manual',
      reason: 'slot_too_close',
    });
  });

  it('leaves it to reception when the offer would last less than five minutes', () => {
    const now = at('2031-05-15T14:00:00Z');

    expect(offerTiming({ ...base, now, startsAt: plus(now, 64) }).kind).toBe('manual');
    expect(offerTiming({ ...base, now, startsAt: plus(now, 65) })).toEqual({
      kind: 'send',
      sendAt: now,
      expiresAt: plus(now, 5),
    });
  });

  it('sets no minimum lead when the organization asks for none', () => {
    const now = at('2031-05-15T14:00:00Z');

    expect(offerTiming({ ...base, minLeadMinutes: 0, now, startsAt: plus(now, 20) })).toEqual({
      kind: 'send',
      sendAt: now,
      expiresAt: plus(now, 20),
    });
  });

  it('defers an offer that falls in quiet hours to their end, keeping the lead time', () => {
    const now = at('2031-05-16T01:00:00Z'); // 22:00 local on the 15th
    const startsAt = at('2031-05-16T15:00:00Z'); // 12:00 local on the 16th

    expect(offerTiming({ ...base, now, startsAt })).toEqual({
      kind: 'send',
      sendAt: at('2031-05-16T11:00:00Z'), // 08:00 local
      expiresAt: at('2031-05-16T11:30:00Z'),
    });
  });

  it('defers from the small hours of the same day too', () => {
    const now = at('2031-05-16T05:00:00Z'); // 02:00 local

    expect(offerTiming({ ...base, now, startsAt: at('2031-05-16T15:00:00Z') })).toEqual({
      kind: 'send',
      sendAt: at('2031-05-16T11:00:00Z'),
      expiresAt: at('2031-05-16T11:30:00Z'),
    });
  });

  it('does not send when the end of quiet hours leaves less than the lead time', () => {
    const now = at('2031-05-16T01:00:00Z'); // 22:00 local
    const startsAt = at('2031-05-16T11:30:00Z'); // 08:30 local, one hour short of the lead

    expect(offerTiming({ ...base, now, startsAt })).toEqual({
      kind: 'manual',
      reason: 'quiet_hours',
    });
  });

  it('ignores quiet hours the organization turned off', () => {
    const now = at('2031-05-16T01:00:00Z');

    expect(
      offerTiming({
        ...base,
        quiet: { start: '08:00', end: '08:00' },
        now,
        startsAt: at('2031-05-16T15:00:00Z'),
      }),
    ).toEqual({ kind: 'send', sendAt: now, expiresAt: plus(now, 30) });
  });

  it('ends quiet hours at the real 08:00 on a day the clocks change', () => {
    // Madrid moves to summer time on 2031-03-30 at 02:00: 08:00 local is then 06:00 UTC.
    const now = at('2031-03-29T22:00:00Z'); // 23:00 local before the change

    expect(
      offerTiming({
        ...base,
        timeZone: 'Europe/Madrid',
        now,
        startsAt: at('2031-03-30T12:00:00Z'),
      }),
    ).toEqual({
      kind: 'send',
      sendAt: at('2031-03-30T06:00:00Z'),
      expiresAt: at('2031-03-30T06:30:00Z'),
    });
  });
});

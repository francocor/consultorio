import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  addLocalDays,
  chooseOccurrence,
  dayBounds,
  elapsedMinutes,
  instantAtLocalMinute,
  isKnownZone,
  localParts,
  resolveLocal,
  weekdayOfDate,
} from './time.js';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const MADRID = 'Europe/Madrid';
const NEW_YORK = 'America/New_York';

const iso = (date: Date) => date.toISOString();

describe('resolveLocal', () => {
  it('resolves an ordinary local time to one instant, in a zone with no daylight saving', () => {
    const result = resolveLocal(BUENOS_AIRES, { date: '2026-07-14', time: '10:00' });

    expect(result).toEqual({ kind: 'ok', instant: new Date('2026-07-14T13:00:00.000Z') });
  });

  it('resolves winter and summer times with their own offset', () => {
    expect(resolveLocal(MADRID, { date: '2026-01-15', time: '10:00' })).toEqual({
      kind: 'ok',
      instant: new Date('2026-01-15T09:00:00.000Z'),
    });
    expect(resolveLocal(MADRID, { date: '2026-07-15', time: '10:00' })).toEqual({
      kind: 'ok',
      instant: new Date('2026-07-15T08:00:00.000Z'),
    });
  });

  it.each([
    [MADRID, '2026-03-29', '02:00'],
    [MADRID, '2026-03-29', '02:30'],
    [MADRID, '2026-03-29', '02:59'],
    [NEW_YORK, '2026-03-08', '02:15'],
  ])('rejects %s %s %s: spring forward skips it', (zone, date, time) => {
    expect(resolveLocal(zone, { date, time })).toEqual({ kind: 'nonexistent' });
  });

  it('accepts the minute before and the minute after the skipped hour', () => {
    expect(resolveLocal(MADRID, { date: '2026-03-29', time: '01:59' }).kind).toBe('ok');
    expect(resolveLocal(MADRID, { date: '2026-03-29', time: '03:00' }).kind).toBe('ok');
  });

  it.each([
    [MADRID, '2026-10-25', '02:00', '2026-10-25T00:00:00.000Z', '2026-10-25T01:00:00.000Z'],
    [MADRID, '2026-10-25', '02:30', '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z'],
    [NEW_YORK, '2026-11-01', '01:30', '2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'],
  ])('flags %s %s %s as ambiguous with both instants, earlier first', (zone, date, time, a, b) => {
    const result = resolveLocal(zone, { date, time });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect([iso(result.first), iso(result.second)]).toEqual([a, b]);
    }
  });

  it('is not ambiguous just outside the repeated hour', () => {
    expect(resolveLocal(MADRID, { date: '2026-10-25', time: '01:59' }).kind).toBe('ok');
    expect(resolveLocal(MADRID, { date: '2026-10-25', time: '03:00' }).kind).toBe('ok');
  });

  it('rejects a malformed date, time or zone instead of guessing', () => {
    expect(() => resolveLocal('Mars/Olympus', { date: '2026-07-14', time: '10:00' })).toThrow();
    expect(() => resolveLocal(MADRID, { date: '2026-02-30', time: '10:00' })).toThrow();
    expect(() => resolveLocal(MADRID, { date: '2026-07-14', time: '25:00' })).toThrow();
  });
});

describe('chooseOccurrence', () => {
  it('returns the instant of an ordinary time whatever the choice', () => {
    const resolution = resolveLocal(MADRID, { date: '2026-07-15', time: '10:00' });

    expect(chooseOccurrence(resolution)).toEqual({
      ok: true,
      instant: new Date('2026-07-15T08:00:00.000Z'),
    });
    expect(chooseOccurrence(resolution, 'second').ok).toBe(true);
  });

  it('asks which occurrence is meant when the time repeats, and stores the chosen one', () => {
    const resolution = resolveLocal(MADRID, { date: '2026-10-25', time: '02:30' });

    expect(chooseOccurrence(resolution)).toEqual({ ok: false, reason: 'ambiguous' });
    expect(chooseOccurrence(resolution, 'first')).toEqual({
      ok: true,
      instant: new Date('2026-10-25T00:30:00.000Z'),
    });
    expect(chooseOccurrence(resolution, 'second')).toEqual({
      ok: true,
      instant: new Date('2026-10-25T01:30:00.000Z'),
    });
  });

  it('refuses a time that does not exist', () => {
    expect(chooseOccurrence(resolveLocal(MADRID, { date: '2026-03-29', time: '02:30' }))).toEqual({
      ok: false,
      reason: 'nonexistent',
    });
  });
});

describe('localParts', () => {
  it('shows an instant in the zone of the location, not the zone of the viewer', () => {
    const instant = new Date('2026-07-14T13:00:00.000Z');

    expect(localParts(BUENOS_AIRES, instant)).toEqual({
      date: '2026-07-14',
      minuteOfDay: 600,
      weekday: 2,
    });
    expect(localParts('Asia/Tokyo', instant)).toEqual({
      date: '2026-07-14',
      minuteOfDay: 22 * 60,
      weekday: 2,
    });
  });

  it('moves to the next local day when the zone is ahead of UTC', () => {
    expect(localParts('Pacific/Auckland', new Date('2026-07-14T13:00:00.000Z'))).toEqual({
      date: '2026-07-15',
      minuteOfDay: 60,
      weekday: 3,
    });
  });

  it('numbers weekdays 1 (Monday) to 7 (Sunday)', () => {
    expect(weekdayOfDate('2026-07-13')).toBe(1);
    expect(weekdayOfDate('2026-07-19')).toBe(7);
  });
});

describe('dayBounds', () => {
  it('is 24 hours on an ordinary day', () => {
    const { start, end } = dayBounds(MADRID, '2026-07-15');

    expect(iso(start)).toBe('2026-07-14T22:00:00.000Z');
    expect(elapsedMinutes(start, end)).toBe(24 * 60);
  });

  it('is 23 hours on the day clocks go forward and 25 on the day they go back', () => {
    const spring = dayBounds(MADRID, '2026-03-29');
    const autumn = dayBounds(MADRID, '2026-10-25');

    expect(elapsedMinutes(spring.start, spring.end)).toBe(23 * 60);
    expect(elapsedMinutes(autumn.start, autumn.end)).toBe(25 * 60);
  });
});

describe('addLocalDays', () => {
  it('keeps the local time across a daylight saving change', () => {
    const before = new Date('2026-03-28T09:00:00.000Z'); // 10:00 in Madrid (UTC+1)

    expect(iso(addLocalDays(MADRID, before, 7))).toBe('2026-04-04T08:00:00.000Z'); // 10:00 (UTC+2)
  });

  it('moves a local time that falls in the skipped hour to the first valid time after it', () => {
    const saturday = new Date('2026-03-28T01:30:00.000Z'); // 02:30 in Madrid

    expect(iso(addLocalDays(MADRID, saturday, 1))).toBe('2026-03-29T01:30:00.000Z'); // 03:30
  });

  it('is exact in a zone without daylight saving', () => {
    const start = new Date('2026-07-14T13:00:00.000Z');

    expect(iso(addLocalDays(BUENOS_AIRES, start, 7))).toBe('2026-07-21T13:00:00.000Z');
  });
});

describe('instantAtLocalMinute', () => {
  it('reads a minute of the local day', () => {
    expect(iso(instantAtLocalMinute(MADRID, '2026-07-15', 600))).toBe('2026-07-15T08:00:00.000Z');
    expect(iso(instantAtLocalMinute(BUENOS_AIRES, '2026-07-14', 0))).toBe(
      '2026-07-14T03:00:00.000Z',
    );
  });

  it('reads minute 1440 as the start of the next local day', () => {
    expect(iso(instantAtLocalMinute(MADRID, '2026-03-29', 1440))).toBe('2026-03-29T22:00:00.000Z');
  });

  it('takes the transition itself when the minute falls in the skipped hour', () => {
    // Madrid skips 02:00-03:00 on 2026-03-29: the clocks jump at 01:00 UTC.
    expect(iso(instantAtLocalMinute(MADRID, '2026-03-29', 150))).toBe('2026-03-29T01:00:00.000Z');
    expect(iso(instantAtLocalMinute(MADRID, '2026-03-29', 120))).toBe('2026-03-29T01:00:00.000Z');
  });

  it('takes the first occurrence of a repeated minute unless told otherwise', () => {
    expect(iso(instantAtLocalMinute(MADRID, '2026-10-25', 150))).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(instantAtLocalMinute(MADRID, '2026-10-25', 150, 'second'))).toBe(
      '2026-10-25T01:30:00.000Z',
    );
  });
});

describe('durations and zones', () => {
  it('measures a duration in elapsed minutes, not wall-clock difference', () => {
    // 01:30 to 03:30 on the night clocks go forward is ONE hour of elapsed time.
    const start = new Date('2026-03-29T00:30:00.000Z');
    const end = new Date('2026-03-29T01:30:00.000Z');

    expect(localParts(MADRID, start).minuteOfDay).toBe(90);
    expect(localParts(MADRID, end).minuteOfDay).toBe(210);
    expect(elapsedMinutes(start, end)).toBe(60);
  });

  it('knows real zones and refuses made-up ones', () => {
    expect(isKnownZone(BUENOS_AIRES)).toBe(true);
    expect(isKnownZone('UTC')).toBe(true);
    expect(isKnownZone('Mars/Olympus')).toBe(false);
    expect(isKnownZone('')).toBe(false);
  });
});

describe('properties', () => {
  const zones = [BUENOS_AIRES, MADRID, NEW_YORK, 'Australia/Lord_Howe', 'Asia/Kolkata'];

  it('a resolved local time reads back as the same local time', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...zones),
        fc.integer({ min: 0, max: 3650 }),
        fc.integer({ min: 0, max: 1439 }),
        (zone, dayOffset, minute) => {
          const date = new Date(Date.UTC(2026, 0, 1 + dayOffset)).toISOString().slice(0, 10);
          const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
          const result = resolveLocal(zone, { date, time });
          if (result.kind === 'nonexistent') return true;
          const instants = result.kind === 'ok' ? [result.instant] : [result.first, result.second];
          return instants.every((instant) => {
            const parts = localParts(zone, instant);
            return parts.date === date && parts.minuteOfDay === minute;
          });
        },
      ),
      { numRuns: 400 },
    );
  });
});

import { describe, expect, it } from 'vitest';

import {
  findHoursProblems,
  formatClock,
  parseClock,
  zoneOffsetMinutes,
  type HoursEntry,
} from './hours.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');

describe('parseClock and formatClock', () => {
  it.each([
    ['00:00', 0],
    ['09:30', 570],
    ['23:59', 1439],
    ['24:00', 1440],
  ])('reads %s as %i minutes', (text, minutes) => {
    expect(parseClock(text)).toBe(minutes);
  });

  it('writes minutes back as the same text', () => {
    for (const text of ['00:00', '09:30', '13:05', '24:00']) {
      expect(formatClock(parseClock(text))).toBe(text);
    }
  });
});

describe('zoneOffsetMinutes', () => {
  it('knows Argentina has no daylight saving time', () => {
    expect(zoneOffsetMinutes('America/Argentina/Buenos_Aires', NOW)).toBe(-180);
    expect(
      zoneOffsetMinutes('America/Argentina/Buenos_Aires', new Date('2026-01-15T12:00:00Z')),
    ).toBe(-180);
  });

  it('follows the daylight saving time of the reference instant', () => {
    expect(zoneOffsetMinutes('Europe/Madrid', NOW)).toBe(120);
    expect(zoneOffsetMinutes('Europe/Madrid', new Date('2026-01-15T12:00:00Z'))).toBe(60);
  });

  it('reads UTC as zero and fractions of an hour', () => {
    expect(zoneOffsetMinutes('UTC', NOW)).toBe(0);
    expect(zoneOffsetMinutes('Asia/Kolkata', NOW)).toBe(330);
  });
});

const entry = (locationId: string, weekday: number, start: string, end: string): HoursEntry => ({
  locationId,
  weekday,
  startMinute: parseClock(start),
  endMinute: parseClock(end),
});

const BA = 'ba';
const BA2 = 'ba-2';
const MADRID = 'madrid';
const UTC = 'utc';
const offsets = new Map([
  [BA, -180],
  [BA2, -180],
  [MADRID, 120],
  [UTC, 0],
]);

describe('findHoursProblems', () => {
  it('accepts a clean week, including intervals that touch', () => {
    expect(
      findHoursProblems(
        [
          entry(BA, 1, '09:00', '13:00'),
          entry(BA, 1, '13:00', '17:00'),
          entry(BA, 2, '09:00', '13:00'),
          entry(BA2, 3, '09:00', '13:00'),
        ],
        offsets,
      ),
    ).toEqual([]);
  });

  it('rejects an end before the start and an empty interval', () => {
    expect(
      findHoursProblems([entry(BA, 1, '13:00', '09:00'), entry(BA, 2, '10:00', '10:00')], offsets),
    ).toEqual([
      { index: 0, path: 'hours.0.end', i18nKey: 'staff.hours.end_before_start' },
      { index: 1, path: 'hours.1.end', i18nKey: 'staff.hours.end_before_start' },
    ]);
  });

  it('rejects Monday 09:00-13:00 at one location and Monday 12:00-16:00 at another', () => {
    expect(
      findHoursProblems([entry(BA, 1, '09:00', '13:00'), entry(BA2, 1, '12:00', '16:00')], offsets),
    ).toEqual([{ index: 1, path: 'hours.1', i18nKey: 'staff.hours.overlap' }]);
  });

  it('rejects an overlap at the same location, whatever the order of the list', () => {
    const problems = findHoursProblems(
      [entry(BA, 1, '10:00', '12:00'), entry(BA, 1, '09:00', '11:00')],
      offsets,
    );

    expect(problems.map((problem) => problem.i18nKey)).toEqual(['staff.hours.overlap']);
  });

  it('compares absolute instants when locations use different zones', () => {
    // 09:00-12:00 in Buenos Aires is 12:00-15:00 UTC; 14:00-17:00 in Madrid is 12:00-15:00 UTC.
    expect(
      findHoursProblems(
        [entry(BA, 1, '09:00', '12:00'), entry(MADRID, 1, '14:00', '17:00')],
        offsets,
      ),
    ).toHaveLength(1);
    // The same local times are different instants: no overlap.
    expect(
      findHoursProblems(
        [entry(BA, 1, '09:00', '12:00'), entry(MADRID, 1, '09:00', '12:00')],
        offsets,
      ),
    ).toEqual([]);
  });

  it('compares across the change of weekday that a zone offset causes', () => {
    // Sunday 23:00-24:00 in Buenos Aires is Monday 02:00-03:00 UTC.
    expect(
      findHoursProblems([entry(BA, 7, '23:00', '24:00'), entry(UTC, 1, '02:30', '03:30')], offsets),
    ).toHaveLength(1);
  });

  it('compares across the end of the week', () => {
    // Madrid Monday 00:30-01:30 is Sunday 22:30-23:30 UTC; Buenos Aires Sunday 19:30-20:30 is
    // Sunday 22:30-23:30 UTC.
    expect(
      findHoursProblems(
        [entry(MADRID, 1, '00:30', '01:30'), entry(BA, 7, '19:30', '20:30')],
        offsets,
      ),
    ).toHaveLength(1);
  });

  it('reports every overlapping entry once, by the later one in the list', () => {
    const problems = findHoursProblems(
      [
        entry(BA, 1, '09:00', '12:00'),
        entry(BA2, 1, '10:00', '11:00'),
        entry(BA, 1, '11:00', '13:00'),
        entry(BA, 2, '09:00', '12:00'),
      ],
      offsets,
    );

    expect(problems.map((problem) => problem.index)).toEqual([1, 2]);
  });

  it('refuses an entry whose location has no known offset instead of guessing', () => {
    expect(findHoursProblems([entry('mystery', 1, '09:00', '10:00')], offsets)).toEqual([
      { index: 0, path: 'hours.0.locationId', i18nKey: 'staff.hours.location_unknown' },
    ]);
  });
});

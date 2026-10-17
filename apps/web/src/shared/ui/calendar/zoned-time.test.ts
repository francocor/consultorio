import { describe, expect, it } from 'vitest';

import {
  addDays,
  localDateOf,
  minutesOfDay,
  monthGridDates,
  rangeInstants,
  startOfWeek,
  weekDates,
  weekdayOf,
  zonedInstant,
} from './zoned-time.js';

const BA = 'America/Argentina/Buenos_Aires';
const NEW_YORK = 'America/New_York';

describe('reading an instant in the zone of the location', () => {
  it('gives the local date and the minutes since local midnight, not the device ones', () => {
    // 02:30 UTC is 23:30 of the previous day in Buenos Aires (UTC-3).
    expect(localDateOf('2026-03-10T02:30:00Z', BA)).toBe('2026-03-09');
    expect(minutesOfDay('2026-03-10T02:30:00Z', BA)).toBe(23 * 60 + 30);
  });

  it('reads the same instant differently in another zone', () => {
    expect(localDateOf('2026-03-10T02:30:00Z', 'Asia/Tokyo')).toBe('2026-03-10');
    expect(minutesOfDay('2026-03-10T02:30:00Z', 'Asia/Tokyo')).toBe(11 * 60 + 30);
  });

  it('shows midnight as minute zero, not 24:00', () => {
    expect(minutesOfDay('2026-03-10T03:00:00Z', BA)).toBe(0);
    expect(localDateOf('2026-03-10T03:00:00Z', BA)).toBe('2026-03-10');
  });
});

describe('building an instant from a local wall-clock time', () => {
  it('uses the fixed offset of Buenos Aires', () => {
    expect(zonedInstant('2026-03-10', 9 * 60, BA).toISOString()).toBe('2026-03-10T12:00:00.000Z');
  });

  it('follows daylight saving in a zone that has it', () => {
    // New York is UTC-5 before 8 March 2026 and UTC-4 after.
    expect(zonedInstant('2026-03-07', 12 * 60, NEW_YORK).toISOString()).toBe(
      '2026-03-07T17:00:00.000Z',
    );
    expect(zonedInstant('2026-03-09', 12 * 60, NEW_YORK).toISOString()).toBe(
      '2026-03-09T16:00:00.000Z',
    );
  });

  it('round-trips with minutesOfDay', () => {
    const instant = zonedInstant('2026-11-01', 13 * 60 + 15, NEW_YORK);

    expect(localDateOf(instant, NEW_YORK)).toBe('2026-11-01');
    expect(minutesOfDay(instant, NEW_YORK)).toBe(13 * 60 + 15);
  });
});

describe('calendar dates', () => {
  it('adds days across month and year ends', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('numbers weekdays from Monday as 1 to Sunday as 7', () => {
    expect(weekdayOf('2026-10-12')).toBe(1);
    expect(weekdayOf('2026-10-17')).toBe(6);
    expect(weekdayOf('2026-10-18')).toBe(7);
  });

  it('starts the week on Monday', () => {
    expect(startOfWeek('2026-10-17')).toBe('2026-10-12');
    expect(startOfWeek('2026-10-12')).toBe('2026-10-12');
    expect(startOfWeek('2026-10-18')).toBe('2026-10-12');
  });

  it('lists the seven days of a week', () => {
    expect(weekDates('2026-10-17')).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ]);
  });

  it('builds a month grid of whole Monday-to-Sunday weeks', () => {
    // February 2026 starts on a Sunday: the grid begins on the Monday before it.
    const february = monthGridDates('2026-02-10');
    expect(february[0]).toBe('2026-01-26');
    expect(february.at(-1)).toBe('2026-03-01');
    expect(february).toHaveLength(35);

    // October 2026 starts on a Thursday and ends on a Saturday.
    const october = monthGridDates('2026-10-17');
    expect(october[0]).toBe('2026-09-28');
    expect(october.at(-1)).toBe('2026-11-01');

    // A month that spills into a sixth week.
    expect(monthGridDates('2026-08-15')).toHaveLength(42);
  });
});

describe('the window of instants a view needs from the API', () => {
  it('is the local day, midnight to midnight, in the zone of the location', () => {
    expect(rangeInstants('day', '2026-10-17', BA)).toEqual({
      from: '2026-10-17T03:00:00.000Z',
      to: '2026-10-18T03:00:00.000Z',
    });
  });

  it('is a 23-hour window on the day clocks go forward', () => {
    expect(rangeInstants('day', '2026-03-08', NEW_YORK)).toEqual({
      from: '2026-03-08T05:00:00.000Z',
      to: '2026-03-09T04:00:00.000Z',
    });
  });

  it('covers Monday to the next Monday for a week', () => {
    expect(rangeInstants('week', '2026-10-17', BA)).toEqual({
      from: '2026-10-12T03:00:00.000Z',
      to: '2026-10-19T03:00:00.000Z',
    });
  });

  it('covers the whole month grid for a month', () => {
    expect(rangeInstants('month', '2026-10-17', BA)).toEqual({
      from: '2026-09-28T03:00:00.000Z',
      to: '2026-11-02T03:00:00.000Z',
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  groupByDay,
  summarizeDay,
  toMinutes,
  validateIntervals,
  type DayInterval,
} from './hours.js';

const interval = (start: string, end: string): DayInterval => ({ start, end });

describe('toMinutes', () => {
  it('reads clock times, with 24:00 as the end of the day', () => {
    expect(toMinutes('00:00')).toBe(0);
    expect(toMinutes('09:30')).toBe(570);
    expect(toMinutes('24:00')).toBe(1440);
  });
});

describe('validateIntervals (one day of one location)', () => {
  it('accepts separate, ordered intervals', () => {
    expect(validateIntervals([interval('09:00', '13:00'), interval('15:00', '19:00')])).toEqual([
      null,
      null,
    ]);
  });

  it('flags an interval that ends before it starts, or at the same time', () => {
    expect(validateIntervals([interval('13:00', '09:00')])).toEqual(['end_before_start']);
    expect(validateIntervals([interval('09:00', '09:00')])).toEqual(['end_before_start']);
  });

  it('flags overlapping intervals on both sides, and leaves the rest alone', () => {
    expect(
      validateIntervals([
        interval('09:00', '12:00'),
        interval('11:00', '14:00'),
        interval('16:00', '18:00'),
      ]),
    ).toEqual(['overlap', 'overlap', null]);
  });

  it('lets one interval end exactly when the next one starts', () => {
    expect(validateIntervals([interval('09:00', '12:00'), interval('12:00', '14:00')])).toEqual([
      null,
      null,
    ]);
  });

  it('treats an interval with a missing time as not valid yet', () => {
    expect(validateIntervals([interval('', '12:00')])).toEqual(['end_before_start']);
  });
});

describe('groupByDay and summarizeDay', () => {
  const rows = [
    { locationId: 'l1', weekday: 3, start: '09:00', end: '13:00' },
    { locationId: 'l1', weekday: 1, start: '15:00', end: '19:00' },
    { locationId: 'l1', weekday: 1, start: '09:00', end: '12:00' },
    { locationId: 'l2', weekday: 1, start: '08:00', end: '09:00' },
  ];

  it('groups one location by weekday and sorts each day by start time', () => {
    const days = groupByDay(rows, 'l1');

    expect(days.get(1)).toEqual([interval('09:00', '12:00'), interval('15:00', '19:00')]);
    expect(days.get(3)).toEqual([interval('09:00', '13:00')]);
    expect(days.get(2)).toBeUndefined();
  });

  it('writes a day as a short line', () => {
    expect(summarizeDay([interval('09:00', '12:00'), interval('15:00', '19:00')])).toBe(
      '09:00–12:00 · 15:00–19:00',
    );
    expect(summarizeDay([])).toBe('');
  });
});

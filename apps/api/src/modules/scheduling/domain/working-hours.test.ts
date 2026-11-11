import { describe, expect, it } from 'vitest';

import {
  mergeRanges,
  overlapsAny,
  subtractRanges,
  workingWindows,
  type HoursPeriod,
  type HoursRow,
} from './working-hours.js';

const BA = 'America/Argentina/Buenos_Aires';
const MADRID = 'Europe/Madrid';
const CENTRO = 'centro';
const NORTE = 'norte';

const row = (locationId: string, weekday: number, start: string, end: string): HoursRow => {
  const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
  return { locationId, weekday, startMinute: minutes(start), endMinute: minutes(end) };
};
const utc = (text: string) => Date.parse(text);
const show = (windows: { start: number; end: number }[]) =>
  windows.map((w) => [new Date(w.start).toISOString(), new Date(w.end).toISOString()]);

describe('workingWindows', () => {
  // 2026-07-13 is a Monday.
  const weekly = [
    row(CENTRO, 1, '09:00', '13:00'),
    row(CENTRO, 1, '14:00', '18:00'),
    row(NORTE, 2, '09:00', '12:00'),
  ];

  it('reads the weekly hours of the location in the location zone', () => {
    const windows = workingWindows({
      zone: BA,
      locationId: CENTRO,
      dates: ['2026-07-13'],
      weekly,
      periods: [],
    });

    expect(show(windows)).toEqual([
      ['2026-07-13T12:00:00.000Z', '2026-07-13T16:00:00.000Z'],
      ['2026-07-13T17:00:00.000Z', '2026-07-13T21:00:00.000Z'],
    ]);
  });

  it('offers nothing on a weekday the professional does not work at that location', () => {
    expect(
      workingWindows({ zone: BA, locationId: CENTRO, dates: ['2026-07-14'], weekly, periods: [] }),
    ).toEqual([]);
    expect(
      workingWindows({ zone: BA, locationId: NORTE, dates: ['2026-07-13'], weekly, periods: [] }),
    ).toEqual([]);
  });

  it('follows the daylight saving time of the zone', () => {
    const madridWeekly = [row(CENTRO, 1, '10:00', '12:00')];
    const input = { zone: MADRID, locationId: CENTRO, weekly: madridWeekly, periods: [] };

    const winter = workingWindows({ ...input, dates: ['2026-03-23'] });
    const summer = workingWindows({ ...input, dates: ['2026-03-30'] });

    expect(show(winter)[0]).toEqual(['2026-03-23T09:00:00.000Z', '2026-03-23T11:00:00.000Z']);
    expect(show(summer)[0]).toEqual(['2026-03-30T08:00:00.000Z', '2026-03-30T10:00:00.000Z']);
  });

  it('merges intervals that touch', () => {
    const windows = workingWindows({
      zone: BA,
      locationId: CENTRO,
      dates: ['2026-07-13'],
      weekly: [row(CENTRO, 1, '09:00', '13:00'), row(CENTRO, 1, '13:00', '14:00')],
      periods: [],
    });

    expect(show(windows)).toEqual([['2026-07-13T12:00:00.000Z', '2026-07-13T17:00:00.000Z']]);
  });

  it('lets a period of dates replace the weekly hours for that range', () => {
    const periods: HoursPeriod[] = [
      { dateFrom: '2026-07-13', dateTo: '2026-07-19', rows: [row(CENTRO, 1, '10:00', '11:00')] },
    ];

    const windows = workingWindows({
      zone: BA,
      locationId: CENTRO,
      dates: ['2026-07-13', '2026-07-20'],
      weekly,
      periods,
    });

    expect(show(windows)).toEqual([
      ['2026-07-13T13:00:00.000Z', '2026-07-13T14:00:00.000Z'],
      // The week after the period is back to the weekly default.
      ['2026-07-20T12:00:00.000Z', '2026-07-20T16:00:00.000Z'],
      ['2026-07-20T17:00:00.000Z', '2026-07-20T21:00:00.000Z'],
    ]);
  });

  it('treats a period without intervals as time off, and includes both end dates', () => {
    const periods: HoursPeriod[] = [{ dateFrom: '2026-07-13', dateTo: '2026-07-13', rows: [] }];
    const input = { zone: BA, locationId: CENTRO, weekly, periods };

    expect(workingWindows({ ...input, dates: ['2026-07-13'] })).toEqual([]);
    expect(workingWindows({ ...input, dates: ['2026-07-20'] })).toHaveLength(2);
  });

  it('puts a period at another location in place of the weekly hours here', () => {
    const periods: HoursPeriod[] = [
      { dateFrom: '2026-07-13', dateTo: '2026-07-13', rows: [row(NORTE, 1, '09:00', '12:00')] },
    ];

    expect(
      workingWindows({ zone: BA, locationId: CENTRO, dates: ['2026-07-13'], weekly, periods }),
    ).toEqual([]);
  });

  it('handles an interval that ends at midnight on the day clocks go forward', () => {
    const windows = workingWindows({
      zone: MADRID,
      locationId: CENTRO,
      dates: ['2026-03-29'],
      weekly: [row(CENTRO, 7, '00:00', '24:00')],
      periods: [],
    });

    // 23 hours long: the day Madrid skips an hour.
    expect(windows).toHaveLength(1);
    expect(((windows[0]?.end ?? 0) - (windows[0]?.start ?? 0)) / 3_600_000).toBe(23);
  });

  it('moves a start that falls in the skipped hour to the first time after it', () => {
    const windows = workingWindows({
      zone: MADRID,
      locationId: CENTRO,
      dates: ['2026-03-29'],
      weekly: [row(CENTRO, 7, '02:30', '05:00')],
      periods: [],
    });

    expect(show(windows)[0]).toEqual(['2026-03-29T01:00:00.000Z', '2026-03-29T03:00:00.000Z']);
  });
});

describe('range arithmetic', () => {
  const r = (a: string, b: string) => ({ start: utc(a), end: utc(b) });

  it('merges overlapping and touching ranges', () => {
    expect(
      show(
        mergeRanges([
          r('2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'),
          r('2026-01-01T09:00:00Z', '2026-01-01T10:00:00Z'),
          r('2026-01-01T12:00:00Z', '2026-01-01T13:00:00Z'),
        ]),
      ),
    ).toEqual([
      ['2026-01-01T09:00:00.000Z', '2026-01-01T11:00:00.000Z'],
      ['2026-01-01T12:00:00.000Z', '2026-01-01T13:00:00.000Z'],
    ]);
  });

  it('subtracts blocks from working windows', () => {
    const windows = [r('2026-01-01T09:00:00Z', '2026-01-01T13:00:00Z')];
    const cuts = [r('2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z')];

    expect(show(subtractRanges(windows, cuts))).toEqual([
      ['2026-01-01T09:00:00.000Z', '2026-01-01T10:00:00.000Z'],
      ['2026-01-01T11:00:00.000Z', '2026-01-01T13:00:00.000Z'],
    ]);
    // A block that covers the whole window, and one that misses it.
    expect(subtractRanges(windows, [r('2026-01-01T08:00:00Z', '2026-01-01T14:00:00Z')])).toEqual(
      [],
    );
    expect(subtractRanges(windows, [r('2026-01-02T08:00:00Z', '2026-01-02T14:00:00Z')])).toEqual(
      windows,
    );
  });

  it('tells whether a range touches any of a set', () => {
    const windows = [r('2026-01-01T09:00:00Z', '2026-01-01T13:00:00Z')];

    expect(overlapsAny(windows, r('2026-01-01T12:59:00Z', '2026-01-01T13:30:00Z'))).toBe(true);
    expect(overlapsAny(windows, r('2026-01-01T13:00:00Z', '2026-01-01T13:30:00Z'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { weeklyOccurrences } from './blocks.js';

const MADRID = 'Europe/Madrid';
const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const iso = (date: Date) => date.toISOString();

describe('weekly occurrences of a block', () => {
  it('keeps the local hour across a daylight saving change', () => {
    const start = new Date('2026-03-24T09:00:00.000Z'); // Tuesday 10:00 in Madrid (UTC+1)
    const end = new Date('2026-03-24T11:00:00.000Z'); // 12:00

    const occurrences = weeklyOccurrences(MADRID, start, end, { count: 3 });

    expect(occurrences.map((o) => [iso(o.startsAt), iso(o.endsAt)])).toEqual([
      ['2026-03-24T09:00:00.000Z', '2026-03-24T11:00:00.000Z'],
      ['2026-03-31T08:00:00.000Z', '2026-03-31T10:00:00.000Z'], // 10:00-12:00 in UTC+2
      ['2026-04-07T08:00:00.000Z', '2026-04-07T10:00:00.000Z'],
    ]);
  });

  it('never produces an empty or negative interval when a start falls in the skipped hour (JD-S2 S9)', () => {
    // Sunday 02:30-03:30 in Madrid. The next Sunday is the spring change: 02:30 does not exist
    // there, and the start moves to 03:30, which is where the end used to be.
    const start = new Date('2026-03-22T01:30:00.000Z');
    const end = new Date('2026-03-22T02:30:00.000Z');

    const occurrences = weeklyOccurrences(MADRID, start, end, { count: 3 });

    expect(occurrences).toHaveLength(3);
    for (const occurrence of occurrences) {
      expect(occurrence.endsAt.getTime()).toBeGreaterThan(occurrence.startsAt.getTime());
      // Every occurrence lasts as long as the first one.
      expect(occurrence.endsAt.getTime() - occurrence.startsAt.getTime()).toBe(
        end.getTime() - start.getTime(),
      );
    }
  });

  describe('a block whose end falls on a later local day (JD-S2 R2-C1)', () => {
    const NEW_YORK = 'America/New_York'; // spring change 2026-03-08, fall change 2026-11-01
    const pairs = (list: { startsAt: Date; endsAt: Date }[]) =>
      list.map((o) => [iso(o.startsAt), iso(o.endsAt)]);

    it('keeps an all-day block midnight to midnight across the spring change', () => {
      // Sunday 2026-03-01 00:00 to Monday 00:00 (EST). The next Sunday is the spring change day, so
      // that occurrence is 23 hours long and must still end at local midnight.
      const start = new Date('2026-03-01T05:00:00.000Z');
      const end = new Date('2026-03-02T05:00:00.000Z');

      expect(pairs(weeklyOccurrences(NEW_YORK, start, end, { count: 3 }))).toEqual([
        ['2026-03-01T05:00:00.000Z', '2026-03-02T05:00:00.000Z'],
        ['2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'], // 00:00 EST to 00:00 EDT
        ['2026-03-15T04:00:00.000Z', '2026-03-16T04:00:00.000Z'],
      ]);
    });

    it('keeps an all-day block midnight to midnight across the fall change', () => {
      // Sunday 2026-10-25 00:00 to Monday 00:00 (EDT). 2026-11-01 is 25 hours long.
      const start = new Date('2026-10-25T04:00:00.000Z');
      const end = new Date('2026-10-26T04:00:00.000Z');

      expect(pairs(weeklyOccurrences(NEW_YORK, start, end, { count: 3 }))).toEqual([
        ['2026-10-25T04:00:00.000Z', '2026-10-26T04:00:00.000Z'],
        ['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z'], // 00:00 EDT to 00:00 EST
        ['2026-11-08T05:00:00.000Z', '2026-11-09T05:00:00.000Z'],
      ]);
    });

    it('keeps an overnight block 22:00 to 06:00 across the spring change', () => {
      // Saturday 22:00 to Sunday 06:00 (EST). The night of 2026-03-07 loses an hour.
      const start = new Date('2026-03-01T03:00:00.000Z');
      const end = new Date('2026-03-01T11:00:00.000Z');

      expect(pairs(weeklyOccurrences(NEW_YORK, start, end, { count: 3 }))).toEqual([
        ['2026-03-01T03:00:00.000Z', '2026-03-01T11:00:00.000Z'],
        ['2026-03-08T03:00:00.000Z', '2026-03-08T10:00:00.000Z'], // 22:00 EST to 06:00 EDT
        ['2026-03-15T02:00:00.000Z', '2026-03-15T10:00:00.000Z'],
      ]);
    });

    it('keeps an overnight block 22:00 to 06:00 across the fall change', () => {
      // Saturday 22:00 to Sunday 06:00 (EDT). The night of 2026-10-31 gains an hour.
      const start = new Date('2026-10-25T02:00:00.000Z');
      const end = new Date('2026-10-25T10:00:00.000Z');

      expect(pairs(weeklyOccurrences(NEW_YORK, start, end, { count: 3 }))).toEqual([
        ['2026-10-25T02:00:00.000Z', '2026-10-25T10:00:00.000Z'],
        ['2026-11-01T02:00:00.000Z', '2026-11-01T11:00:00.000Z'], // 22:00 EDT to 06:00 EST
        ['2026-11-08T03:00:00.000Z', '2026-11-08T11:00:00.000Z'],
      ]);
    });

    it('keeps a Friday evening to Monday morning block across a change', () => {
      // Friday 18:00 to Monday 08:00 (EST); the span of 2026-03-06 includes the spring change.
      const start = new Date('2026-02-27T23:00:00.000Z');
      const end = new Date('2026-03-02T13:00:00.000Z');

      expect(pairs(weeklyOccurrences(NEW_YORK, start, end, { count: 2 }))).toEqual([
        ['2026-02-27T23:00:00.000Z', '2026-03-02T13:00:00.000Z'],
        ['2026-03-06T23:00:00.000Z', '2026-03-09T12:00:00.000Z'], // 18:00 EST to 08:00 EDT
      ]);
    });
  });

  it('is exact in a zone without daylight saving', () => {
    const start = new Date('2026-07-14T13:00:00.000Z');
    const end = new Date('2026-07-14T14:30:00.000Z');

    const occurrences = weeklyOccurrences(BUENOS_AIRES, start, end, { until: '2026-07-28' });

    expect(occurrences.map((o) => iso(o.endsAt))).toEqual([
      '2026-07-14T14:30:00.000Z',
      '2026-07-21T14:30:00.000Z',
      '2026-07-28T14:30:00.000Z',
    ]);
  });
});

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

import { describe, expect, it } from 'vitest';

import { currentMonth, rangeIssue, groupDays } from './period.js';

describe('currentMonth', () => {
  it('is the first to the last day of the month at the clinic, not in UTC', () => {
    // 2031-06-01 01:30 UTC is still 31 May 22:30 in Buenos Aires.
    expect(currentMonth(new Date('2031-06-01T01:30:00.000Z'))).toEqual({
      from: '2031-05-01',
      to: '2031-05-31',
    });
    expect(currentMonth(new Date('2032-02-15T15:00:00.000Z'))).toEqual({
      from: '2032-02-01',
      to: '2032-02-29',
    });
  });
});

describe('rangeIssue', () => {
  it('accepts a month and the longest span', () => {
    expect(rangeIssue({ from: '2031-05-01', to: '2031-05-31' })).toBeNull();
    expect(rangeIssue({ from: '2032-01-01', to: '2032-12-31' })).toBeNull();
  });

  it('names an inverted range and a span that is too long', () => {
    expect(rangeIssue({ from: '2031-05-31', to: '2031-05-01' })).toBe('inverted');
    expect(rangeIssue({ from: '2031-01-01', to: '2032-01-02' })).toBe('too_long');
  });

  it('asks for both dates when one is missing', () => {
    expect(rangeIssue({ from: '', to: '2031-05-01' })).toBe('missing');
    expect(rangeIssue({ from: '2031-05-01', to: '' })).toBe('missing');
  });
});

describe('groupDays', () => {
  const day = (
    date: string,
    total: number,
    attended: number,
    noShow: number,
    cancelled: number,
  ) => ({
    date,
    total,
    attended,
    noShow,
    cancelled,
    noShowRateBp: null,
  });

  it('keeps one bar per day for a period of two months or less', () => {
    const grouped = groupDays([day('2031-05-12', 3, 2, 1, 0), day('2031-05-13', 1, 1, 0, 0)]);

    expect(grouped.unit).toBe('day');
    expect(grouped.rows.map((row) => [row.key, row.total])).toEqual([
      ['2031-05-12', 3],
      ['2031-05-13', 1],
    ]);
  });

  it('adds up by month when the days span more than two months', () => {
    const grouped = groupDays([
      day('2031-01-10', 2, 1, 1, 0),
      day('2031-01-20', 3, 3, 0, 0),
      day('2031-03-05', 4, 2, 1, 1),
    ]);

    expect(grouped.unit).toBe('month');
    expect(grouped.rows).toEqual([
      { key: '2031-01', total: 5, attended: 4, noShow: 1, cancelled: 0 },
      { key: '2031-03', total: 4, attended: 2, noShow: 1, cancelled: 1 },
    ]);
  });
});

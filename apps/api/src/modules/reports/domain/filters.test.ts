import { describe, expect, it } from 'vitest';

import { rangeProblems, spanInDays } from './filters.js';

describe('spanInDays', () => {
  it('counts both ends of the range', () => {
    expect(spanInDays({ from: '2031-05-12', to: '2031-05-12' })).toBe(1);
    expect(spanInDays({ from: '2031-05-01', to: '2031-05-31' })).toBe(31);
  });

  it('counts the leap day', () => {
    expect(spanInDays({ from: '2032-01-01', to: '2032-12-31' })).toBe(366);
    expect(spanInDays({ from: '2031-01-01', to: '2031-12-31' })).toBe(365);
  });
});

describe('rangeProblems', () => {
  it('accepts a month, a single day and the longest allowed span (366 days)', () => {
    expect(rangeProblems({ from: '2031-05-01', to: '2031-05-31' })).toEqual([]);
    expect(rangeProblems({ from: '2031-05-12', to: '2031-05-12' })).toEqual([]);
    expect(rangeProblems({ from: '2032-01-01', to: '2032-12-31' })).toEqual([]);
  });

  it('says "to" is before "from" when the range is inverted, and nothing else', () => {
    expect(rangeProblems({ from: '2031-05-31', to: '2031-05-01' })).toEqual([
      { path: 'to', i18nKey: 'reports.range.inverted' },
    ]);
  });

  it('refuses a span of more than 366 days, naming the field that makes it too long', () => {
    expect(rangeProblems({ from: '2031-01-01', to: '2032-01-02' })).toEqual([
      { path: 'to', i18nKey: 'reports.range.too_long' },
    ]);
    expect(rangeProblems({ from: '2031-01-01', to: '2036-01-01' })).toEqual([
      { path: 'to', i18nKey: 'reports.range.too_long' },
    ]);
  });

  it('allows the span to be tightened by the caller', () => {
    expect(rangeProblems({ from: '2031-05-01', to: '2031-05-31' }, 10)).toEqual([
      { path: 'to', i18nKey: 'reports.range.too_long' },
    ]);
  });
});

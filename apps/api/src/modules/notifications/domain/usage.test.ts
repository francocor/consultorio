import { describe, expect, it } from 'vitest';

import { periodOf, thresholdsReached, usageState } from './usage.js';

describe('periodOf', () => {
  it('is the calendar month of the instant, in UTC', () => {
    expect(periodOf(new Date('2031-05-12T13:00:00.000Z'))).toBe('2031-05');
    expect(periodOf(new Date('2031-12-31T23:59:59.999Z'))).toBe('2031-12');
    expect(periodOf(new Date('2032-01-01T00:00:00.000Z'))).toBe('2032-01');
  });
});

describe('usageState', () => {
  it('is unlimited when the plan applies no quota', () => {
    expect(usageState(0, null)).toBe('unlimited');
    expect(usageState(10_000, null)).toBe('unlimited');
  });

  it('is ok below 80%, warning from 80% and exhausted at the quota', () => {
    expect(usageState(0, 200)).toBe('ok');
    expect(usageState(159, 200)).toBe('ok');
    expect(usageState(160, 200)).toBe('warning');
    expect(usageState(199, 200)).toBe('warning');
    expect(usageState(200, 200)).toBe('exhausted');
    expect(usageState(250, 200)).toBe('exhausted');
  });

  it('works with a small quota where 80% is not a whole message', () => {
    expect(usageState(3, 5)).toBe('ok');
    expect(usageState(4, 5)).toBe('warning');
    expect(usageState(5, 5)).toBe('exhausted');
  });
});

describe('thresholdsReached', () => {
  it('lists the thresholds the count has reached, lowest first', () => {
    expect(thresholdsReached(0, 200)).toEqual([]);
    expect(thresholdsReached(159, 200)).toEqual([]);
    expect(thresholdsReached(160, 200)).toEqual([80]);
    expect(thresholdsReached(200, 200)).toEqual([80, 100]);
    expect(thresholdsReached(500, 200)).toEqual([80, 100]);
  });

  it('has no threshold without a quota', () => {
    expect(thresholdsReached(1_000, null)).toEqual([]);
  });
});

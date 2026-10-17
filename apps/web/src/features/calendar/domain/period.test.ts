import { describe, expect, it } from 'vitest';

import { movePeriod, periodLabel, regionLabelKey } from './period.js';

describe('moving through time', () => {
  it('moves a day at a time in the day view', () => {
    expect(movePeriod('day', '2026-10-17', 1)).toBe('2026-10-18');
    expect(movePeriod('day', '2026-10-01', -1)).toBe('2026-09-30');
  });

  it('moves a week at a time in the week view', () => {
    expect(movePeriod('week', '2026-10-17', 1)).toBe('2026-10-24');
    expect(movePeriod('week', '2026-10-03', -1)).toBe('2026-09-26');
  });

  it('moves a month at a time in the month view, keeping the day inside shorter months', () => {
    expect(movePeriod('month', '2026-10-17', 1)).toBe('2026-11-17');
    expect(movePeriod('month', '2026-01-31', 1)).toBe('2026-02-28');
    expect(movePeriod('month', '2026-01-15', -1)).toBe('2025-12-15');
  });
});

describe('the words for the period on screen', () => {
  it('names the day, the week from Monday to Sunday, and the month', () => {
    expect(periodLabel('day', '2026-10-17')).toBe('sábado 17 de octubre');
    expect(periodLabel('week', '2026-10-17')).toBe('12 oct al 18 oct');
    expect(periodLabel('month', '2026-10-17')).toBe('octubre de 2026');
  });

  it('chooses the catalog key of the calendar region by view', () => {
    expect(regionLabelKey('day')).toBe('calendar.regionDay');
    expect(regionLabelKey('week')).toBe('calendar.regionWeek');
    expect(regionLabelKey('month')).toBe('calendar.regionMonth');
  });
});

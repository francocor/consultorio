import { describe, expect, it } from 'vitest';

import {
  MORNING,
  AFTERNOON,
  describeDays,
  describeRanges,
  rangeProblem,
  toggleDay,
  weekdayName,
} from './preferences.js';

describe('the days of the week', () => {
  it('names Monday to Sunday in Spanish, short or long', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((day) => weekdayName(day, 'short'))).toEqual([
      'lun',
      'mar',
      'mié',
      'jue',
      'vie',
      'sáb',
      'dom',
    ]);
    expect(weekdayName(1, 'long')).toBe('lunes');
    expect(weekdayName(7, 'long')).toBe('domingo');
  });

  it('lists the chosen days in week order, and says nothing when any day will do', () => {
    expect(describeDays([5, 1, 3])).toBe('lun, mié, vie');
    expect(describeDays([])).toBeNull();
  });

  it('adds a day to the choice and takes it away, keeping the week order', () => {
    expect(toggleDay([1, 5], 3)).toEqual([1, 3, 5]);
    expect(toggleDay([1, 3, 5], 3)).toEqual([1, 5]);
    expect(toggleDay([], 7)).toEqual([7]);
  });
});

describe('the hours of the day', () => {
  it('offers the morning and the afternoon as two ready-made ranges', () => {
    expect(MORNING).toEqual({ from: '08:00', to: '12:00' });
    expect(AFTERNOON).toEqual({ from: '12:00', to: '18:00' });
  });

  it('writes the ranges, and says nothing when any time will do', () => {
    expect(describeRanges([MORNING, { from: '14:30', to: '17:00' }])).toBe(
      '08:00 a 12:00, 14:30 a 17:00',
    );
    expect(describeRanges([])).toBeNull();
  });

  it('finds what is wrong with a range, if anything', () => {
    expect(rangeProblem({ from: '08:00', to: '12:00' })).toBeNull();
    expect(rangeProblem({ from: '', to: '12:00' })).toBe('empty');
    expect(rangeProblem({ from: '08:00', to: '' })).toBe('empty');
    expect(rangeProblem({ from: '12:00', to: '12:00' })).toBe('order');
    expect(rangeProblem({ from: '14:00', to: '09:00' })).toBe('order');
  });
});

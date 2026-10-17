import { describe, expect, it } from 'vitest';

import { isFutureDate, isMinor } from './age.js';

const today = new Date('2031-05-05T12:00:00Z');

describe('who is a minor', () => {
  it('is the person who has not reached the age of majority yet', () => {
    expect(isMinor('2020-01-01', 18, today)).toBe(true);
    expect(isMinor('2013-05-06', 18, today)).toBe(true);
    expect(isMinor('1990-04-02', 18, today)).toBe(false);
  });

  it('counts the day of the birthday as majority', () => {
    expect(isMinor('2013-05-05', 18, today)).toBe(false);
    expect(isMinor('2013-05-06', 18, today)).toBe(true);
  });

  it('rolls a leap-day birthday over to the first of March', () => {
    expect(isMinor('2012-02-29', 18, new Date('2030-02-28T00:00:00Z'))).toBe(true);
    expect(isMinor('2012-02-29', 18, new Date('2030-03-01T00:00:00Z'))).toBe(false);
  });

  it('follows the age of the country', () => {
    expect(isMinor('2012-01-01', 21, today)).toBe(true);
    expect(isMinor('2012-01-01', 16, today)).toBe(false);
  });
});

describe('a date in the future', () => {
  it('is any day after today', () => {
    expect(isFutureDate('2031-05-06', today)).toBe(true);
    expect(isFutureDate('2031-05-05', today)).toBe(false);
    expect(isFutureDate('2000-01-01', today)).toBe(false);
  });
});

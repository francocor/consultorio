import { describe, expect, it } from 'vitest';

import { isFutureDate, isMinor } from './age.js';

describe('isMinor', () => {
  const today = new Date('2031-05-12T15:00:00Z');

  it.each([
    ['born the day they would turn 18 in a year', '2013-05-13', true],
    ['turns 18 tomorrow', '2013-05-13', true],
    ['turns 18 today', '2013-05-12', false],
    ['turned 18 yesterday', '2013-05-11', false],
    ['an adult', '1990-04-02', false],
    ['a newborn', '2031-05-01', true],
  ])('%s (%s)', (_name, birthDate, minor) => {
    expect(isMinor(birthDate, 18, today)).toBe(minor);
  });

  it('follows the age of majority of the country', () => {
    expect(isMinor('2013-05-12', 21, today)).toBe(true);
  });

  it('handles the 29th of February', () => {
    // Born on a leap day: 18 on 2031-02-28 or 03-01; before that they are a minor.
    expect(isMinor('2012-02-29', 18, new Date('2030-02-28T12:00:00Z'))).toBe(true);
    expect(isMinor('2012-02-29', 18, new Date('2030-03-01T12:00:00Z'))).toBe(false);
  });
});

describe('isFutureDate', () => {
  it('is true only after today', () => {
    const today = new Date('2031-05-12T15:00:00Z');

    expect(isFutureDate('2031-05-13', today)).toBe(true);
    expect(isFutureDate('2031-05-12', today)).toBe(false);
    expect(isFutureDate('1990-01-01', today)).toBe(false);
  });
});

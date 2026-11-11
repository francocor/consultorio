import { describe, expect, it } from 'vitest';

import { isMinor, majorityDate } from './majority.js';

describe('majorityDate', () => {
  it.each([
    ['2010-05-17', 18, '2028-05-17'],
    ['2000-01-01', 18, '2018-01-01'],
    ['2012-12-31', 18, '2030-12-31'],
    ['2005-09-30', 21, '2026-09-30'],
  ])('is the day someone born on %s turns %i: %s', (birth, age, expected) => {
    expect(majorityDate(birth, age)).toBe(expected);
  });

  it('puts a 29 February birthday on 1 March in a year without one, never earlier', () => {
    expect(majorityDate('2008-02-29', 18)).toBe('2026-03-01');
    expect(majorityDate('2004-02-29', 18)).toBe('2022-03-01');
  });

  it('keeps 29 February when the year has one', () => {
    expect(majorityDate('2000-02-29', 24)).toBe('2024-02-29');
  });
});

describe('isMinor', () => {
  it('is true up to the day before the birthday and false on it', () => {
    expect(isMinor('2010-05-17', '2028-05-16', 18)).toBe(true);
    expect(isMinor('2010-05-17', '2028-05-17', 18)).toBe(false);
    expect(isMinor('2010-05-17', '2040-01-01', 18)).toBe(false);
  });

  it('treats a baby as a minor', () => {
    expect(isMinor('2026-10-01', '2026-10-16', 18)).toBe(true);
  });
});

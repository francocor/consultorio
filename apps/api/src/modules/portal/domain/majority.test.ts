import { describe, expect, it } from 'vitest';

import { majorityReviewDate } from './majority.js';

describe('the day a representative link is reviewed', () => {
  const today = new Date('2031-05-05T12:00:00.000Z');

  it('is the 18th birthday of a minor', () => {
    expect(majorityReviewDate({ birthDate: '2020-09-14', majorityAge: 18, today })).toBe(
      '2038-09-14',
    );
  });

  it('is the day itself for a minor who turns 18 tomorrow', () => {
    expect(majorityReviewDate({ birthDate: '2013-05-06', majorityAge: 18, today })).toBe(
      '2031-05-06',
    );
  });

  it('is null for somebody who is already an adult: the organization verified the representation', () => {
    expect(majorityReviewDate({ birthDate: '2010-05-05', majorityAge: 18, today })).toBeNull();
    expect(majorityReviewDate({ birthDate: '1960-01-01', majorityAge: 18, today })).toBeNull();
  });

  it('follows the age of majority of the country', () => {
    expect(majorityReviewDate({ birthDate: '2020-09-14', majorityAge: 21, today })).toBe(
      '2041-09-14',
    );
  });

  it('moves a 29 February birth to the first of March in a year that has no 29th', () => {
    expect(majorityReviewDate({ birthDate: '2016-02-29', majorityAge: 18, today })).toBe(
      '2034-03-01',
    );
  });
});

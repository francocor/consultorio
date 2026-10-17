import { describe, expect, it } from 'vitest';

import { prosOf, validateCalendarSearch } from './search.js';

const ID = '0190a000-0000-7000-8000-00000000000a';
const ID2 = '0190a000-0000-7000-8000-00000000000b';

describe('the address of the agenda', () => {
  it('defaults to the day view with nothing else chosen', () => {
    expect(validateCalendarSearch({})).toEqual({
      view: 'day',
      date: undefined,
      location: undefined,
      pros: undefined,
      cancelled: undefined,
      list: undefined,
      appointment: undefined,
    });
  });

  it('keeps what is valid', () => {
    expect(
      validateCalendarSearch({
        view: 'week',
        date: '2026-10-17',
        location: ID,
        pros: `${ID},${ID2}`,
        cancelled: true,
        list: true,
        appointment: ID2,
      }),
    ).toEqual({
      view: 'week',
      date: '2026-10-17',
      location: ID,
      pros: `${ID},${ID2}`,
      cancelled: true,
      list: true,
      appointment: ID2,
    });
  });

  it('throws away anything malformed instead of passing it to the API', () => {
    expect(
      validateCalendarSearch({
        view: 'year',
        date: '17/10/2026',
        location: 'not-an-id',
        pros: `${ID},drop table,${ID2}`,
        cancelled: 'maybe',
        appointment: '<script>',
      }),
    ).toEqual({
      view: 'day',
      date: undefined,
      location: undefined,
      pros: `${ID},${ID2}`,
      cancelled: undefined,
      list: undefined,
      appointment: undefined,
    });
  });

  it('reads the professionals back as a list', () => {
    expect(prosOf(validateCalendarSearch({ pros: `${ID},${ID2}` }))).toEqual([ID, ID2]);
    expect(prosOf(validateCalendarSearch({}))).toEqual([]);
  });

  it('refuses a date that does not exist', () => {
    expect(validateCalendarSearch({ date: '2026-02-30' }).date).toBeUndefined();
  });
});

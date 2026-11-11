import { describe, expect, it } from 'vitest';

import { isClosedDay, mergeHolidays } from './holidays.js';

const CATALOG = [
  { date: '2026-12-25', name: 'Navidad', kind: 'national' as const },
  { date: '2026-12-07', name: 'Feriado puente', kind: 'bridge' as const },
];

describe('mergeHolidays', () => {
  it('puts the catalog and the organization days in one list sorted by date', () => {
    const merged = mergeHolidays(CATALOG, [
      { id: 'a', day: '2026-09-17', name: 'Local holiday', locationId: null },
    ]);

    expect(merged.map((holiday) => [holiday.day, holiday.source])).toEqual([
      ['2026-09-17', 'organization'],
      ['2026-12-07', 'bridge'],
      ['2026-12-25', 'national'],
    ]);
  });

  it('keeps the catalog entry first when the organization marks the same day', () => {
    const merged = mergeHolidays(CATALOG, [
      { id: 'a', day: '2026-12-25', name: 'Closure', locationId: 'place' },
    ]);

    expect(merged.filter((holiday) => holiday.day === '2026-12-25')).toMatchObject([
      { source: 'national', dayOffId: null, locationId: null },
      { source: 'organization', dayOffId: 'a', locationId: 'place' },
    ]);
  });

  it('does not change the catalog it was given', () => {
    const catalog = structuredClone(CATALOG);

    mergeHolidays(catalog, [{ id: 'a', day: '2026-01-02', name: 'x', locationId: null }]);

    expect(catalog).toEqual(CATALOG);
  });
});

describe('isClosedDay', () => {
  const holidays = mergeHolidays(CATALOG, [
    { id: 'a', day: '2026-10-12', name: 'Closure of Norte', locationId: 'norte' },
  ]);

  it('closes every location on a national holiday', () => {
    expect(isClosedDay(holidays, '2026-12-25', 'centro')?.name).toBe('Navidad');
    expect(isClosedDay(holidays, '2026-12-25', 'norte')?.name).toBe('Navidad');
  });

  it('closes only the location a day off is limited to', () => {
    expect(isClosedDay(holidays, '2026-10-12', 'norte')?.name).toBe('Closure of Norte');
    expect(isClosedDay(holidays, '2026-10-12', 'centro')).toBeNull();
  });

  it('is open on an ordinary day', () => {
    expect(isClosedDay(holidays, '2026-06-01', 'centro')).toBeNull();
  });
});

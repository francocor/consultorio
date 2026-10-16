import { describe, expect, it } from 'vitest';

import { arHolidays, easterSunday } from './ar-holidays.js';

const byDate = (year: number) =>
  new Map(arHolidays(year).map((holiday) => [holiday.date, holiday]));

describe('Easter (Gregorian computus)', () => {
  it.each([
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
  ])('Easter %i falls on %s', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });
});

describe('Argentine national holidays', () => {
  it('includes Christmas 2026 with its name (spec scenario)', () => {
    expect(byDate(2026).get('2026-12-25')).toEqual({
      country: 'AR',
      date: '2026-12-25',
      name: 'Navidad',
      kind: 'national',
    });
  });

  it('derives Carnival and Good Friday from Easter', () => {
    const holidays2026 = byDate(2026);
    const holidays2028 = byDate(2028);

    expect(holidays2026.get('2026-02-16')?.name).toBe('Carnaval');
    expect(holidays2026.get('2026-02-17')?.name).toBe('Carnaval');
    expect(holidays2026.get('2026-04-03')?.name).toBe('Viernes Santo');
    // 2028 is a leap year: Easter on 16 April puts Carnival on 28 and 29 February.
    expect(holidays2028.get('2028-02-28')?.name).toBe('Carnaval');
    expect(holidays2028.get('2028-02-29')?.name).toBe('Carnaval');
    expect(holidays2028.get('2028-04-14')?.name).toBe('Viernes Santo');
  });

  it('keeps immovable holidays on their date', () => {
    const holidays = byDate(2026);

    for (const date of [
      '2026-01-01',
      '2026-03-24',
      '2026-04-02',
      '2026-05-01',
      '2026-05-25',
      '2026-06-20',
      '2026-07-09',
      '2026-12-08',
    ]) {
      expect(holidays.has(date), date).toBe(true);
    }
  });

  it('moves a movable holiday to the previous Monday when it falls on Tuesday or Wednesday', () => {
    // 17 June 2026 is a Wednesday.
    expect(byDate(2026).get('2026-06-15')?.name).toContain('Güemes');
    expect(byDate(2026).has('2026-06-17')).toBe(false);
    // 12 October 2027 is a Tuesday.
    expect(byDate(2027).get('2027-10-11')?.name).toBe('Día del Respeto a la Diversidad Cultural');
  });

  it('moves a movable holiday to the next Monday when it falls on Thursday or Friday', () => {
    // 20 November 2026 is a Friday.
    expect(byDate(2026).get('2026-11-23')?.name).toBe('Día de la Soberanía Nacional');
    expect(byDate(2026).has('2026-11-20')).toBe(false);
  });

  it('leaves a movable holiday alone when it falls on a Monday, Saturday or Sunday', () => {
    // 17 August 2026 is a Monday.
    expect(byDate(2026).get('2026-08-17')?.name).toContain('San Martín');
    // 12 October 2026 is a Monday.
    expect(byDate(2026).get('2026-10-12')?.kind).toBe('national');
  });

  it('adds the declared bridge days of 2026 as kind bridge', () => {
    const holidays = byDate(2026);

    for (const date of ['2026-03-23', '2026-07-10', '2026-12-07']) {
      expect(holidays.get(date)?.kind, date).toBe('bridge');
    }
  });

  it('has no bridge days for years nobody has declared yet', () => {
    expect(arHolidays(2027).filter((holiday) => holiday.kind === 'bridge')).toEqual([]);
  });

  it('is sorted by date and has no duplicate (date, name) for 2026 to 2028', () => {
    for (const year of [2026, 2027, 2028]) {
      const holidays = arHolidays(year);
      const keys = holidays.map((holiday) => `${holiday.date}|${holiday.name}`);

      expect(holidays.length).toBeGreaterThan(14);
      expect(new Set(keys).size).toBe(keys.length);
      expect(holidays.map((holiday) => holiday.date)).toEqual(
        [...holidays.map((holiday) => holiday.date)].sort(),
      );
      expect(holidays.every((holiday) => holiday.date.startsWith(String(year)))).toBe(true);
    }
  });
});

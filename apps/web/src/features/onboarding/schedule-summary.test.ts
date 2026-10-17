import { describe, expect, it } from 'vitest';

import { summarizeWeek, type WeekRow } from './schedule-summary.js';
import { splitSpecialties } from './specialties.js';

const NAMES: Record<number, string> = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
  7: 'Domingo',
};
const name = (weekday: number) => NAMES[weekday] ?? '';

const row = (weekday: number, start = '09:00', end = '17:00', locationId = 'a'): WeekRow => ({
  locationId,
  weekday,
  start,
  end,
});

describe('summarizeWeek', () => {
  it('names a run of days as a range', () => {
    expect(
      summarizeWeek(
        [1, 2, 3, 4, 5].map((day) => row(day)),
        name,
      ),
    ).toBe('Lunes a viernes, 09:00–17:00');
  });

  it('lists days that are not in a run, with "y" before the last', () => {
    expect(summarizeWeek([row(1), row(3), row(5)], name)).toBe(
      'Lunes, miércoles y viernes, 09:00–17:00',
    );
  });

  it('joins a run and a lone day', () => {
    expect(summarizeWeek([row(1), row(2), row(3), row(6)], name)).toBe(
      'Lunes a miércoles y sábado, 09:00–17:00',
    );
  });

  it('keeps two days next to each other as a list, not a range', () => {
    expect(summarizeWeek([row(2), row(3)], name)).toBe('Martes y miércoles, 09:00–17:00');
    expect(summarizeWeek([row(4)], name)).toBe('Jueves, 09:00–17:00');
  });

  it('is not a plain week when the times differ between days', () => {
    expect(summarizeWeek([row(1), row(2, '10:00', '14:00')], name)).toBeNull();
  });

  it('is not a plain week with two intervals in a day or two places', () => {
    expect(summarizeWeek([row(1), row(1, '18:00', '20:00')], name)).toBeNull();
    expect(summarizeWeek([row(1), row(2, '09:00', '17:00', 'b')], name)).toBeNull();
  });

  it('has nothing to say about an empty week', () => {
    expect(summarizeWeek([], name)).toBeNull();
  });
});

describe('splitSpecialties', () => {
  it('keeps one entry per comma, trimmed', () => {
    expect(splitSpecialties(' Pediatría , Neonatología')).toEqual(['Pediatría', 'Neonatología']);
  });

  it('drops empty entries and repeats, ignoring case', () => {
    expect(splitSpecialties('Pediatría,, pediatría ,')).toEqual(['Pediatría']);
    expect(splitSpecialties('   ')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import {
  formatAge,
  formatDate,
  formatDateTime,
  formatDayLong,
  formatDayShort,
  formatDocument,
  formatMonthYear,
  formatMoney,
  formatTime,
  formatWeekdayShort,
} from './format.js';

/** Intl uses no-break and narrow spaces; compare with plain ones. */
const plain = (value: string) => value.replaceAll(' ', ' ').replaceAll(' ', ' ');

describe('formatDate and formatTime (es-AR, location time zone)', () => {
  const instant = '2026-03-05T02:30:00.000Z';

  it('renders the date in the given time zone, which can differ from UTC', () => {
    // 02:30 UTC is still the 4th at night in Buenos Aires (UTC-3).
    expect(formatDate(instant, { timeZone: 'America/Argentina/Buenos_Aires' })).toBe('04/03/2026');
    expect(formatDate(instant, { timeZone: 'UTC' })).toBe('05/03/2026');
  });

  it('renders 24-hour time and date with time', () => {
    expect(formatTime(instant, { timeZone: 'America/Argentina/Buenos_Aires' })).toBe('23:30');
    expect(plain(formatDateTime(instant, { timeZone: 'America/Argentina/Buenos_Aires' }))).toBe(
      '04/03/2026, 23:30',
    );
  });

  it('shows a dash for a missing value instead of "Invalid Date"', () => {
    expect(formatDate(null)).toBe('-');
    expect(formatDate('not a date')).toBe('-');
    expect(formatTime(undefined)).toBe('-');
  });

  it('defaults to the Argentina time zone', () => {
    expect(formatTime(instant)).toBe('23:30');
  });
});

describe('formatMoney', () => {
  it('uses Argentine separators and the peso sign', () => {
    expect(plain(formatMoney(1234.5))).toBe('$ 1.234,50');
    expect(plain(formatMoney(0))).toBe('$ 0,00');
  });

  it('formats negative amounts and another currency', () => {
    expect(plain(formatMoney(-90))).toBe('-$ 90,00');
    expect(plain(formatMoney(10, 'USD'))).toContain('10,00');
  });
});

describe('formatDocument', () => {
  it('groups a national id with dots', () => {
    expect(formatDocument('dni', '12345678')).toBe('12.345.678');
    expect(formatDocument('dni', '5123456')).toBe('5.123.456');
  });

  it('keeps passports as they are, in capitals', () => {
    expect(formatDocument('passport', 'ab123456')).toBe('AB123456');
  });

  it('formats a tax id as 20-12345678-3', () => {
    expect(formatDocument('cuit', '20123456786')).toBe('20-12345678-6');
  });
});

describe('formatAge', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('counts whole years, and months for babies', () => {
    expect(formatAge('1990-06-15', now)).toBe('36 años');
    expect(formatAge('1990-06-16', now)).toBe('35 años');
    expect(formatAge('2026-03-10', now)).toBe('3 meses');
    expect(formatAge('2025-06-14', now)).toBe('1 año');
  });

  it('shows nothing for a missing or invalid birth date', () => {
    expect(formatAge(null, now)).toBe('');
    expect(formatAge('zzz', now)).toBe('');
  });
});

describe('calendar day labels (a calendar day, never shifted by a time zone)', () => {
  it('writes a day the way it is said: weekday, day and month', () => {
    expect(formatDayLong('2026-10-17')).toBe('sábado 17 de octubre');
    expect(formatDayLong('2026-01-01')).toBe('jueves 1 de enero');
  });

  it('has short forms for headers', () => {
    expect(formatDayShort('2026-10-17')).toBe('17 oct');
    expect(formatWeekdayShort('2026-10-17')).toBe('sáb');
    expect(formatWeekdayShort('2026-10-12')).toBe('lun');
  });

  it('names a month with its year', () => {
    expect(formatMonthYear('2026-10-17')).toBe('octubre de 2026');
    expect(formatMonthYear('2027-02-01')).toBe('febrero de 2027');
  });
});

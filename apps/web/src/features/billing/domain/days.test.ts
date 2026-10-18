import { describe, expect, it } from 'vitest';

import { dayInZone, shiftDay } from './days.js';

describe('the day of an instant in a time zone', () => {
  it('is the calendar day people there are living, not the UTC one', () => {
    // 02:30 UTC on the 13th is still the evening of the 12th in Buenos Aires (UTC-3).
    const instant = new Date('2031-05-13T02:30:00.000Z');

    expect(dayInZone(instant, 'America/Argentina/Buenos_Aires')).toBe('2031-05-12');
    expect(dayInZone(instant, 'UTC')).toBe('2031-05-13');
  });

  it('shifts a day by whole days, across months', () => {
    expect(shiftDay('2031-05-31', 1)).toBe('2031-06-01');
    expect(shiftDay('2031-03-01', -1)).toBe('2031-02-28');
    expect(shiftDay('2031-05-12', 0)).toBe('2031-05-12');
  });
});

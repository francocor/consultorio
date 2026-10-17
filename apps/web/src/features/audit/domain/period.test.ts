import { describe, expect, it } from 'vitest';

import { endOfDayIso, startOfDayIso } from './period.js';

describe('startOfDayIso', () => {
  it('is midnight in Argentina, three hours ahead of UTC', () => {
    expect(startOfDayIso('2026-10-01', 'America/Argentina/Buenos_Aires')).toBe(
      '2026-10-01T03:00:00.000Z',
    );
  });

  it('follows the zone, including daylight saving time', () => {
    expect(startOfDayIso('2026-07-01', 'Europe/Madrid')).toBe('2026-06-30T22:00:00.000Z');
    expect(startOfDayIso('2026-01-15', 'Europe/Madrid')).toBe('2026-01-14T23:00:00.000Z');
  });

  it('is UTC midnight for UTC', () => {
    expect(startOfDayIso('2026-03-09', 'UTC')).toBe('2026-03-09T00:00:00.000Z');
  });
});

describe('endOfDayIso', () => {
  it('is the start of the next day, so the whole last day is inside the period', () => {
    expect(endOfDayIso('2026-10-16', 'America/Argentina/Buenos_Aires')).toBe(
      '2026-10-17T03:00:00.000Z',
    );
  });

  it('crosses month and year ends', () => {
    expect(endOfDayIso('2026-12-31', 'UTC')).toBe('2027-01-01T00:00:00.000Z');
    expect(endOfDayIso('2026-02-28', 'UTC')).toBe('2026-03-01T00:00:00.000Z');
  });
});

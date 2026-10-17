import { describe, expect, it } from 'vitest';

import { applyQuietHours, isInQuietHours, quietHoursEnd } from './quiet-hours.js';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const DEFAULT = { start: '21:00', end: '08:00' };

/** A Buenos Aires wall-clock time (UTC-3 all year) as an instant. */
const ba = (date: string, time: string) => new Date(`${date}T${time}:00-03:00`);

describe('quietHoursEnd', () => {
  it('is null outside quiet hours', () => {
    expect(quietHoursEnd(ba('2031-05-12', '12:00'), BUENOS_AIRES, DEFAULT)).toBeNull();
    expect(quietHoursEnd(ba('2031-05-12', '20:59'), BUENOS_AIRES, DEFAULT)).toBeNull();
    expect(quietHoursEnd(ba('2031-05-12', '08:00'), BUENOS_AIRES, DEFAULT)).toBeNull();
  });

  it('is the next 08:00 of the location when asked at night, before and after midnight', () => {
    expect(quietHoursEnd(ba('2031-05-12', '22:00'), BUENOS_AIRES, DEFAULT)).toEqual(
      ba('2031-05-13', '08:00'),
    );
    expect(quietHoursEnd(ba('2031-05-13', '03:00'), BUENOS_AIRES, DEFAULT)).toEqual(
      ba('2031-05-13', '08:00'),
    );
  });

  it('is null when quiet hours are switched off', () => {
    expect(
      quietHoursEnd(ba('2031-05-12', '23:00'), BUENOS_AIRES, { start: '00:00', end: '00:00' }),
    ).toBeNull();
  });

  it('reads the window in the zone of the location', () => {
    // 17:00 in Buenos Aires is 22:00 in Madrid (CEST, UTC+2): inside quiet hours there only.
    const at = ba('2031-05-12', '17:00');

    expect(quietHoursEnd(at, BUENOS_AIRES, DEFAULT)).toBeNull();
    expect(quietHoursEnd(at, 'Europe/Madrid', DEFAULT)).toEqual(
      new Date('2031-05-13T08:00:00+02:00'),
    );
  });
});

describe('isInQuietHours', () => {
  it('knows a window that wraps midnight', () => {
    const at = (time: string) => isInQuietHours(ba('2031-05-12', time), BUENOS_AIRES, DEFAULT);

    expect(at('20:59')).toBe(false);
    expect(at('21:00')).toBe(true);
    expect(at('23:59')).toBe(true);
    expect(at('00:00')).toBe(true);
    expect(at('07:59')).toBe(true);
    expect(at('08:00')).toBe(false);
    expect(at('12:00')).toBe(false);
  });

  it('knows a window inside one day', () => {
    const lunch = { start: '12:00', end: '14:00' };

    expect(isInQuietHours(ba('2031-05-12', '11:59'), BUENOS_AIRES, lunch)).toBe(false);
    expect(isInQuietHours(ba('2031-05-12', '12:00'), BUENOS_AIRES, lunch)).toBe(true);
    expect(isInQuietHours(ba('2031-05-12', '13:59'), BUENOS_AIRES, lunch)).toBe(true);
    expect(isInQuietHours(ba('2031-05-12', '14:00'), BUENOS_AIRES, lunch)).toBe(false);
  });

  it('treats equal start and end as no quiet hours at all', () => {
    expect(
      isInQuietHours(ba('2031-05-12', '03:00'), BUENOS_AIRES, { start: '00:00', end: '00:00' }),
    ).toBe(false);
  });

  it('reads the window in the zone of the location, not of the server', () => {
    // 2031-05-12 23:30Z is 20:30 in Buenos Aires (awake) and 01:30 on the 13th in Madrid (asleep).
    const instant = new Date('2031-05-12T23:30:00Z');

    expect(isInQuietHours(instant, BUENOS_AIRES, DEFAULT)).toBe(false);
    expect(isInQuietHours(instant, 'Europe/Madrid', DEFAULT)).toBe(true);
  });
});

describe('applyQuietHours', () => {
  it('sends at the due time when it is outside quiet hours', () => {
    const due = ba('2031-05-11', '10:00');

    expect(
      applyQuietHours({
        due,
        startsAt: ba('2031-05-12', '10:00'),
        timeZone: BUENOS_AIRES,
        quiet: DEFAULT,
      }),
    ).toEqual({ kind: 'send', at: due });
  });

  it('defers a reminder due at 07:00 to 08:00 when the appointment is a day later (spec scenario)', () => {
    expect(
      applyQuietHours({
        due: ba('2031-05-11', '07:00'),
        startsAt: ba('2031-05-12', '07:00'),
        timeZone: BUENOS_AIRES,
        quiet: DEFAULT,
      }),
    ).toEqual({ kind: 'send', at: ba('2031-05-11', '08:00') });
  });

  it('skips a reminder that cannot be deferred: 06:30 for a 07:30 appointment (spec scenario)', () => {
    expect(
      applyQuietHours({
        due: ba('2031-05-12', '06:30'),
        startsAt: ba('2031-05-12', '07:30'),
        timeZone: BUENOS_AIRES,
        quiet: DEFAULT,
      }),
    ).toEqual({ kind: 'skip' });
  });

  it('defers a reminder due late in the evening to the next morning', () => {
    expect(
      applyQuietHours({
        due: ba('2031-05-11', '23:15'),
        startsAt: ba('2031-05-13', '10:00'),
        timeZone: BUENOS_AIRES,
        quiet: DEFAULT,
      }),
    ).toEqual({ kind: 'send', at: ba('2031-05-12', '08:00') });
  });

  it('skips when the end of quiet hours is the very start of the appointment or later', () => {
    const due = ba('2031-05-12', '06:00');

    expect(
      applyQuietHours({
        due,
        startsAt: ba('2031-05-12', '08:00'),
        timeZone: BUENOS_AIRES,
        quiet: DEFAULT,
      }),
    ).toEqual({ kind: 'skip' });
    expect(
      applyQuietHours({
        due,
        startsAt: ba('2031-05-12', '08:01'),
        timeZone: BUENOS_AIRES,
        quiet: DEFAULT,
      }),
    ).toEqual({ kind: 'send', at: ba('2031-05-12', '08:00') });
  });

  it('uses the offset in force on a day the clocks go forward (DST starts 2031-03-09 in New York)', () => {
    const result = applyQuietHours({
      // 06:30 local on the day of the change: already UTC-4.
      due: new Date('2031-03-09T10:30:00Z'),
      startsAt: new Date('2031-03-10T14:00:00Z'),
      timeZone: 'America/New_York',
      quiet: DEFAULT,
    });

    // 08:00 EDT is 12:00Z (it would be 13:00Z with the winter offset).
    expect(result).toEqual({ kind: 'send', at: new Date('2031-03-09T12:00:00Z') });
  });

  it('uses the offset in force on a day the clocks go back (DST ends 2031-11-02 in New York)', () => {
    const result = applyQuietHours({
      // 03:30 local on the day of the change: already UTC-5.
      due: new Date('2031-11-02T08:30:00Z'),
      startsAt: new Date('2031-11-03T15:00:00Z'),
      timeZone: 'America/New_York',
      quiet: DEFAULT,
    });

    // 08:00 EST is 13:00Z.
    expect(result).toEqual({ kind: 'send', at: new Date('2031-11-02T13:00:00Z') });
  });

  it('defers across the night that gains an hour, to the real 08:00 of the next day', () => {
    // 22:00 EDT on 2031-03-08 is 03:00Z on the 9th; the clocks jump at 02:00 local that night.
    const result = applyQuietHours({
      due: new Date('2031-03-09T03:00:00Z'),
      startsAt: new Date('2031-03-10T14:00:00Z'),
      timeZone: 'America/New_York',
      quiet: DEFAULT,
    });

    expect(result).toEqual({ kind: 'send', at: new Date('2031-03-09T12:00:00Z') });
  });

  it('sends at the due time when the organization has no quiet hours', () => {
    const due = ba('2031-05-11', '03:00');

    expect(
      applyQuietHours({
        due,
        startsAt: ba('2031-05-12', '10:00'),
        timeZone: BUENOS_AIRES,
        quiet: { start: '08:00', end: '08:00' },
      }),
    ).toEqual({ kind: 'send', at: due });
  });
});

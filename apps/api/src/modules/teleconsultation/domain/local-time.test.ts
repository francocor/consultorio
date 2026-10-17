import { describe, expect, it } from 'vitest';

import { describeInstant } from './local-time.js';

describe('describing an instant in the time of the place', () => {
  it('reads the date and the time in the zone of the location, in es-AR', () => {
    expect(
      describeInstant(new Date('2031-05-12T12:45:00.000Z'), 'America/Argentina/Buenos_Aires'),
    ).toEqual({ date: '12 de mayo', time: '09:45' });
  });

  it('moves to the next day when the zone is ahead of UTC', () => {
    expect(describeInstant(new Date('2031-05-12T23:30:00.000Z'), 'Europe/Madrid')).toEqual({
      date: '13 de mayo',
      time: '01:30',
    });
  });

  it('keeps midnight as 00:00, not 24:00', () => {
    expect(
      describeInstant(new Date('2031-05-12T03:00:00.000Z'), 'America/Argentina/Buenos_Aires'),
    ).toEqual({ date: '12 de mayo', time: '00:00' });
  });
});

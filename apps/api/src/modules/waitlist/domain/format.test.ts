import { describe, expect, it } from 'vitest';

import { dateText, timeText } from './format.js';

describe('how a date and a time are written', () => {
  const instant = new Date('2031-05-12T13:00:00Z');

  it('reads them in the zone of the place', () => {
    expect(dateText(instant, 'America/Argentina/Buenos_Aires')).toBe('lunes, 12 de mayo de 2031');
    expect(timeText(instant, 'America/Argentina/Buenos_Aires')).toBe('10:00');
    // The same instant is already the next morning on the other side of the world.
    expect(dateText(instant, 'Pacific/Auckland')).toBe('martes, 13 de mayo de 2031');
    expect(timeText(instant, 'Pacific/Auckland')).toBe('01:00');
  });

  it('writes midnight as 00:00 and keeps two digits', () => {
    expect(timeText(new Date('2031-05-12T03:05:00Z'), 'UTC')).toBe('03:05');
    expect(timeText(new Date('2031-05-12T00:00:00Z'), 'UTC')).toBe('00:00');
  });
});

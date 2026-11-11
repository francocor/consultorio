import type { LocationDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import { resolveTimeZone } from './time-zone.js';

const location = (id: string, timeZone: string, active = true): LocationDto => ({
  id,
  name: `Sede ${id}`,
  timeZone,
  active,
});

const BA = 'America/Argentina/Buenos_Aires';
const SANTIAGO = 'America/Santiago';

describe('the time zone the calendar is drawn in', () => {
  it('is the zone of the location being looked at', () => {
    const locations = [location('a', BA), location('b', SANTIAGO)];

    expect(resolveTimeZone(locations, 'b')).toBe(SANTIAGO);
    expect(resolveTimeZone(locations, 'a')).toBe(BA);
  });

  it('is the shared zone when every location agrees', () => {
    expect(resolveTimeZone([location('a', SANTIAGO), location('b', SANTIAGO)], undefined)).toBe(
      SANTIAGO,
    );
  });

  it('is the zone of the first active location when they differ', () => {
    expect(
      resolveTimeZone(
        [location('x', 'America/Lima', false), location('a', BA), location('b', SANTIAGO)],
        undefined,
      ),
    ).toBe(BA);
  });

  it('falls back to the country default before the locations are known', () => {
    expect(resolveTimeZone([], undefined)).toBe(BA);
    expect(resolveTimeZone([location('a', SANTIAGO)], 'unknown')).toBe(SANTIAGO);
  });
});

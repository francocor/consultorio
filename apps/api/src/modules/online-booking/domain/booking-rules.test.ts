import { describe, expect, it } from 'vitest';

import {
  SLUG_ALPHABET,
  SLUG_LENGTH,
  dailyCapReached,
  filterBookableSlots,
  localDateOf,
  slugFromBytes,
} from './booking-rules.js';

describe('slugFromBytes', () => {
  it('makes a slug of lowercase letters and digits that the table accepts', () => {
    const slug = slugFromBytes(Uint8Array.from({ length: SLUG_LENGTH }, (_, index) => index * 37));

    expect(slug).toMatch(/^[a-z0-9]{8,32}$/);
    expect(slug).toHaveLength(SLUG_LENGTH);
  });

  it('only uses characters of the alphabet, which leaves out look-alikes', () => {
    const slug = slugFromBytes(Uint8Array.from({ length: SLUG_LENGTH }, (_, index) => index));

    for (const character of slug) expect(SLUG_ALPHABET).toContain(character);
    expect(SLUG_ALPHABET).not.toMatch(/[01lo]/);
    expect(SLUG_ALPHABET).toHaveLength(32);
  });

  it('is different for different bytes and the same for the same bytes', () => {
    const one = Uint8Array.from({ length: SLUG_LENGTH }, () => 1);
    const two = Uint8Array.from({ length: SLUG_LENGTH }, () => 2);

    expect(slugFromBytes(one)).toBe(slugFromBytes(one));
    expect(slugFromBytes(one)).not.toBe(slugFromBytes(two));
  });

  it('refuses too few bytes', () => {
    expect(() => slugFromBytes(new Uint8Array(3))).toThrow();
  });
});

describe('filterBookableSlots', () => {
  const now = new Date('2031-05-12T12:00:00.000Z');
  const hour = 3_600_000;
  const slot = (offsetHours: number) => ({
    startsAt: new Date(now.getTime() + offsetHours * hour).toISOString(),
    endsAt: new Date(now.getTime() + (offsetHours + 0.5) * hour).toISOString(),
  });

  it('drops what starts before the minimum lead time, the boundary included', () => {
    const kept = filterBookableSlots([slot(1), slot(2), slot(3)], {
      now,
      minLeadHours: 2,
      horizonDays: 60,
    });

    expect(kept.map((s) => s.startsAt)).toEqual([slot(2).startsAt, slot(3).startsAt]);
  });

  it('drops what starts after the horizon', () => {
    const kept = filterBookableSlots([slot(24 * 59), slot(24 * 60), slot(24 * 60 + 1)], {
      now,
      minLeadHours: 0,
      horizonDays: 60,
    });

    expect(kept.map((s) => s.startsAt)).toEqual([slot(24 * 59).startsAt, slot(24 * 60).startsAt]);
  });

  it('keeps everything between the two bounds in order', () => {
    const slots = [slot(5), slot(6), slot(30)];

    expect(filterBookableSlots(slots, { now, minLeadHours: 2, horizonDays: 60 })).toEqual(slots);
  });
});

describe('localDateOf', () => {
  it('reads the date in the zone of the location, not in UTC', () => {
    // 01:30 UTC is still the previous evening in Buenos Aires (UTC-3).
    expect(localDateOf('America/Argentina/Buenos_Aires', new Date('2031-05-13T01:30:00Z'))).toBe(
      '2031-05-12',
    );
    expect(localDateOf('UTC', new Date('2031-05-13T01:30:00Z'))).toBe('2031-05-13');
  });
});

describe('dailyCapReached', () => {
  it('is never reached without a cap', () => {
    expect(dailyCapReached(null, 500)).toBe(false);
  });

  it('is reached when the day already has the cap, and not before', () => {
    expect(dailyCapReached(3, 2)).toBe(false);
    expect(dailyCapReached(3, 3)).toBe(true);
    expect(dailyCapReached(3, 4)).toBe(true);
  });
});

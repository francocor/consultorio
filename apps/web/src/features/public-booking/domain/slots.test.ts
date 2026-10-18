import type { PublicSlotDto } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  dayLabel,
  groupByDay,
  longDayLabel,
  slotLabel,
  todayIn,
  zoneLabel,
} from './slots.js';

const zone = 'America/Argentina/Buenos_Aires';
const slot = (startsAt: string, date: string): PublicSlotDto => ({
  startsAt,
  endsAt: startsAt,
  locationId: '0190a000-0000-7000-8000-000000000001',
  date,
});

describe('groupByDay', () => {
  it('groups the slots by their local date, in order', () => {
    const days = groupByDay([
      slot('2031-05-12T12:00:00.000Z', '2031-05-12'),
      slot('2031-05-12T13:00:00.000Z', '2031-05-12'),
      slot('2031-05-14T12:00:00.000Z', '2031-05-14'),
    ]);

    expect(days.map((day) => [day.date, day.slots.length])).toEqual([
      ['2031-05-12', 2],
      ['2031-05-14', 1],
    ]);
  });

  it('is empty when there are no slots', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('labels', () => {
  it('writes a day short, for a button, and long, for a sentence', () => {
    expect(dayLabel('2031-05-12')).toBe('lun 12 may');
    expect(longDayLabel('2031-05-12')).toBe('lunes 12 de mayo');
  });

  it('writes the time of a slot in the zone of the location, never the device', () => {
    expect(slotLabel('2031-05-12T13:00:00.000Z', zone)).toBe('10:00');
    expect(slotLabel('2031-05-12T13:00:00.000Z', 'UTC')).toBe('13:00');
  });

  it('names the zone the times are shown in', () => {
    expect(zoneLabel(zone, new Date('2031-05-12T13:00:00.000Z'))).toBe('Buenos Aires (GMT-3)');
  });
});

describe('dates', () => {
  it('reads today in the zone of the location', () => {
    // 01:30 UTC is still the evening before in Buenos Aires.
    expect(todayIn(zone, new Date('2031-05-13T01:30:00.000Z'))).toBe('2031-05-12');
  });

  it('adds days to a calendar date', () => {
    expect(addDays('2031-05-30', 3)).toBe('2031-06-02');
    expect(addDays('2031-12-31', 1)).toBe('2032-01-01');
  });
});

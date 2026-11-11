import { describe, expect, it } from 'vitest';

import { instantAtLocalMinute, localParts } from '../../../modules/scheduling/domain/time.js';

import { buildDemoDataset } from './dataset.js';
import { buildDemoSchedule } from './schedule.js';

const data = buildDemoDataset();
/** A Monday, 09:00 in Buenos Aires: the start of the working week. */
const MONDAY = new Date('2026-03-02T12:00:00.000Z');
/** A Wednesday afternoon. */
const WEDNESDAY = new Date('2026-03-04T18:30:00.000Z');
/** A Sunday: nobody works. */
const SUNDAY = new Date('2026-03-08T15:00:00.000Z');
const ZONE = 'America/Argentina/Buenos_Aires';

const hoursOf = (professional: string) =>
  data.staff.find((person) => person.key === professional)?.professional?.hours ?? [];
const zoneOf = (locationKey: string) =>
  data.locations.find((place) => place.key === locationKey)?.timeZone ?? ZONE;

function weekdayOf(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

describe('the demo schedule', () => {
  it('is the same for the same moment, and moves with the moment', () => {
    expect(buildDemoSchedule(data, MONDAY)).toEqual(buildDemoSchedule(data, MONDAY));
    const later = buildDemoSchedule(data, new Date(MONDAY.getTime() + 14 * 86_400_000));
    expect(later.appointments[0]?.date).not.toBe(
      buildDemoSchedule(data, MONDAY).appointments[0]?.date,
    );
  });

  it.each([MONDAY, WEDNESDAY, SUNDAY])(
    'every appointment is inside the hours of its professional at its location (%s)',
    (now) => {
      const schedule = buildDemoSchedule(data, now);

      expect(schedule.appointments.length).toBeGreaterThan(30);
      for (const entry of schedule.appointments) {
        const type = schedule.types.find((candidate) => candidate.key === entry.type);
        const row = hoursOf(entry.professional).find(
          (hours) =>
            hours.location === entry.location &&
            hours.weekday === weekdayOf(entry.date) &&
            hours.startMinute <= entry.startMinute &&
            entry.startMinute + (type?.durationMinutes ?? 0) <= hours.endMinute,
        );
        expect(
          row,
          `${entry.professional} ${entry.date} ${String(entry.startMinute)}`,
        ).toBeDefined();
      }
    },
  );

  it('never double-books a professional, buffer included', () => {
    const schedule = buildDemoSchedule(data, MONDAY);
    const busy = new Map<string, { start: number; end: number }[]>();

    for (const entry of schedule.appointments) {
      const type = schedule.types.find((candidate) => candidate.key === entry.type);
      const range = {
        start: entry.startMinute,
        end: entry.startMinute + (type?.durationMinutes ?? 0) + (type?.bufferMinutes ?? 0),
      };
      const key = `${entry.professional}|${entry.date}`;
      const others = busy.get(key) ?? [];
      expect(
        others.some((other) => other.start < range.end && range.start < other.end),
        key,
      ).toBe(false);
      busy.set(key, [...others, range]);
    }
  });

  it('keeps a patient to one appointment a day, and only points at patients that exist', () => {
    const schedule = buildDemoSchedule(data, MONDAY);
    const seen = new Set<string>();

    for (const entry of schedule.appointments) {
      expect(entry.patientIndex).toBeGreaterThanOrEqual(0);
      expect(entry.patientIndex).toBeLessThan(data.patients.length);
      const key = `${String(entry.patientIndex)}|${entry.date}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('sends the children to pediatrics and the adults to the other professionals', () => {
    const schedule = buildDemoSchedule(data, MONDAY);
    const born = (index: number) => data.patients[index]?.birthDate ?? '';

    for (const entry of schedule.appointments) {
      if (entry.professional === 'pediatrics')
        expect(born(entry.patientIndex) >= '2008').toBe(true);
      else expect(born(entry.patientIndex) < '2008').toBe(true);
    }
    expect(schedule.appointments.some((entry) => entry.professional === 'pediatrics')).toBe(true);
  });

  it('leaves the day off and the block free of appointments', () => {
    const schedule = buildDemoSchedule(data, MONDAY);

    expect(schedule.appointments.some((entry) => entry.date === schedule.dayOff.date)).toBe(false);
    const blocked = schedule.appointments.filter(
      (entry) =>
        entry.professional === schedule.block.professional && entry.date === schedule.block.date,
    );
    for (const entry of blocked) {
      expect(
        entry.startMinute >= schedule.block.endMinute ||
          entry.startMinute + 90 <= schedule.block.startMinute,
      ).toBe(true);
    }
  });

  it('covers today, the rest of this week, next week and the week before', () => {
    const schedule = buildDemoSchedule(data, MONDAY);
    const dates = new Set(schedule.appointments.map((entry) => entry.date));
    const today = localParts(ZONE, MONDAY).date;

    expect(dates.has(today)).toBe(true);
    const spread = [...dates].sort();
    expect(spread[0] && spread.at(-1) && spread.at(-1) !== spread[0]).toBe(true);
    // Three weeks of dates: the previous one, this one and the next one.
    const mondays = new Set(
      [...dates].map((date) =>
        new Date(Date.parse(`${date}T00:00:00Z`) - (weekdayOf(date) - 1) * 86_400_000)
          .toISOString()
          .slice(0, 10),
      ),
    );
    expect(mondays.size).toBe(3);
  });

  it('gives statuses that make sense for the moment: the past was attended, missed or cancelled, the future is open', () => {
    const schedule = buildDemoSchedule(data, WEDNESDAY);
    const nowMs = WEDNESDAY.getTime();

    for (const entry of schedule.appointments) {
      const type = schedule.types.find((candidate) => candidate.key === entry.type);
      const zone = zoneOf(entry.location);
      const start = instantAtLocalMinute(zone, entry.date, entry.startMinute).getTime();
      const end = start + (type?.durationMinutes ?? 0) * 60_000;
      if (end <= nowMs) {
        expect(
          ['attended', 'no_show', 'cancelled'],
          `${entry.date} ${String(entry.startMinute)}`,
        ).toContain(entry.status);
      } else if (start > nowMs) {
        expect(['scheduled', 'confirmed', 'checked_in', 'cancelled']).toContain(entry.status);
      }
    }
  });

  it('shows every status in one schedule, so the calendar is not one color', () => {
    const statuses = new Set(
      buildDemoSchedule(data, WEDNESDAY).appointments.map((entry) => entry.status),
    );

    for (const status of [
      'scheduled',
      'confirmed',
      'checked_in',
      'in_progress',
      'attended',
      'no_show',
      'cancelled',
    ]) {
      expect(statuses.has(status as never), status).toBe(true);
    }
  });

  it('includes one booking the professional made for themselves, to show the identity review', () => {
    const schedule = buildDemoSchedule(data, MONDAY);
    const selfBooked = schedule.appointments.filter((entry) => entry.selfBooked);

    expect(selfBooked).toHaveLength(1);
    expect(['scheduled', 'confirmed']).toContain(selfBooked[0]?.status);
  });

  it('has types, a block, a day off and a range of dates with their own hours', () => {
    const schedule = buildDemoSchedule(data, MONDAY);

    expect(schedule.types.length).toBeGreaterThanOrEqual(3);
    expect(schedule.types.every((type) => type.durationMinutes > 0)).toBe(true);
    expect(schedule.block.reason.length).toBeGreaterThan(0);
    expect(schedule.dayOff.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(schedule.period.dateTo >= schedule.period.dateFrom).toBe(true);
  });
});

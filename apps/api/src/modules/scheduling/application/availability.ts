import type { AvailabilityQuery, AvailabilityResponse } from '@consultorio/contracts';

import { AppError } from '../../../platform/http/problem.js';
import { dayBounds, localParts } from '../domain/time.js';

import { invalid, typeOffered } from './placement.js';
import type { LocationRecord, SchedulingPorts } from './ports.js';
import { datesBetween, freeSlots } from './schedule-facts.js';

export interface AvailabilityInput {
  query: AvailabilityQuery;
  now: Date;
  /** The locations the viewer may see: `'all'` for owner and admin, else their own. */
  visibleLocations: 'all' | readonly string[];
  stepMinutes?: number;
}

/** The most slots one answer carries (31 days, several locations, 15 minute starts). */
const MAX_SLOTS = 2000;

/**
 * The free appointment times of a professional for a type, between two local dates: working hours
 * (weekly, or the hours of a range of dates), minus blocks, minus holidays, minus what is already
 * occupied (appointments and active holds, buffers included), in the time zone of each location.
 * A professional is never offered at one location while busy at another. Nothing in the past is
 * offered. Holidays are reported as closed days so a screen can say why a date is empty.
 *
 * Staff see the professional's real capacity; the public flows (Stage 3) ask with capacity 1.
 */
export async function availability(
  ports: SchedulingPorts,
  input: AvailabilityInput,
): Promise<AvailabilityResponse> {
  const { query } = input;
  const professional = await ports.findProfessional(query.professionalId);
  const type = await ports.findType(query.typeId);
  if (!professional || !type) throw new AppError('not_found');
  if (professional.status !== 'active' || !type.active) throw new AppError('conflict');
  if (!typeOffered(type, professional)) {
    throw invalid('typeId', 'scheduling.booking.type_not_offered');
  }

  // The locations where the professional works (or the one asked for), that the viewer may see.
  const hours = await ports.hours(professional.id, '', query.from, query.to);
  const worked = new Set([
    ...hours.weekly.map((row) => row.locationId),
    ...hours.periods.flatMap((period) => period.rows.map((row) => row.locationId)),
  ]);
  const wanted = query.locationId ? [query.locationId] : [...worked].sort();
  const locations: LocationRecord[] = [];
  for (const id of wanted) {
    const found = await ports.findLocation(id);
    if (!found) throw new AppError('not_found');
    if (!found.active) continue;
    if (input.visibleLocations !== 'all' && !input.visibleLocations.includes(found.id)) continue;
    locations.push(found);
  }

  const slots: AvailabilityResponse['slots'] = [];
  const closedDays: AvailabilityResponse['closedDays'] = [];
  for (const location of locations) {
    const zone = location.timeZone;
    const firstInstant = Math.max(input.now.getTime(), dayBounds(zone, query.from).start.getTime());
    const free = await freeSlots(ports, {
      professionalId: professional.id,
      maxSimultaneous: professional.maxSimultaneous,
      location,
      durationMinutes: type.durationMinutes,
      bufferMinutes: type.bufferMinutes,
      from: firstInstant,
      days: datesBetween(localParts(zone, new Date(firstInstant)).date, query.to).length - 1,
      limit: MAX_SLOTS,
      ...(input.stepMinutes === undefined ? {} : { stepMinutes: input.stepMinutes }),
    });
    for (const slot of free) {
      const date = localParts(zone, new Date(slot.start)).date;
      if (date > query.to) continue;
      slots.push({
        startsAt: new Date(slot.start).toISOString(),
        endsAt: new Date(slot.end).toISOString(),
        locationId: location.id,
        date,
      });
    }

    const holidays = await ports.holidays(query.from, query.to);
    for (const holiday of holidays) {
      if (holiday.locationId === null || holiday.locationId === location.id) {
        closedDays.push({
          date: holiday.day,
          locationId: location.id,
          name: holiday.name,
          source: holiday.source,
        });
      }
    }
  }

  slots.sort(
    (a, b) => a.startsAt.localeCompare(b.startsAt) || a.locationId.localeCompare(b.locationId),
  );
  closedDays.sort(
    (a, b) => a.date.localeCompare(b.date) || a.locationId.localeCompare(b.locationId),
  );
  return { professionalId: professional.id, typeId: type.id, slots, closedDays };
}

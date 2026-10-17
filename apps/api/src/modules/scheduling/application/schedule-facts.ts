import type { HolidayDto } from '@consultorio/contracts';

import { findFreeSlots } from '../domain/free-slots.js';
import { isClosedDay } from '../domain/holidays.js';
import { localParts, dayBounds } from '../domain/time.js';
import {
  overlapsAny,
  subtractRanges,
  workingWindows,
  type TimeRange,
} from '../domain/working-hours.js';

import type { LocationRecord, SchedulingPorts } from './ports.js';

const DAY_MS = 86_400_000;

/** Local calendar dates from `from` to `to`, both included. */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (
    let cursor = Date.parse(`${from}T00:00:00Z`);
    cursor <= Date.parse(`${to}T00:00:00Z`);
    cursor += DAY_MS
  ) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
}

export interface ScheduleFacts {
  /** The whole range lies inside one working window of the professional at the location. */
  insideHours: boolean;
  /** A block of the professional (or of the location) touches the range. */
  blocked: boolean;
  /** The holiday or day off that closes the day the range starts on, if any. */
  holiday: HolidayDto | null;
}

/** What the schedule says about one range: working hours, blocks and holidays. */
export async function scheduleFacts(
  ports: SchedulingPorts,
  input: { professionalId: string; location: LocationRecord; range: TimeRange },
): Promise<ScheduleFacts> {
  const zone = input.location.timeZone;
  const startDate = localParts(zone, new Date(input.range.start)).date;
  const endDate = localParts(zone, new Date(input.range.end - 1)).date;

  // One query at a time: all of them share the connection of the transaction.
  const hours = await ports.hours(input.professionalId, input.location.id, startDate, endDate);
  const blocks = await ports.blocks(input.professionalId, input.location.id, input.range);
  const holidays = await ports.holidays(startDate, endDate);
  const windows = workingWindows({
    zone,
    locationId: input.location.id,
    dates: datesBetween(startDate, endDate),
    weekly: hours.weekly,
    periods: hours.periods,
  });
  return {
    insideHours: windows.some(
      (window) => window.start <= input.range.start && input.range.end <= window.end,
    ),
    blocked: overlapsAny(blocks, input.range),
    holiday: isClosedDay(holidays, startDate, input.location.id),
  };
}

export interface FreeSlotsRequest {
  professionalId: string;
  maxSimultaneous: number;
  location: LocationRecord;
  durationMinutes: number;
  bufferMinutes: number;
  /** First instant that may be offered. */
  from: number;
  /** How many local days after the day of `from` to look at. */
  days: number;
  limit: number;
  stepMinutes?: number;
  /** Public flows never use overbooked capacity. */
  capacityOne?: boolean;
}

/**
 * Free appointment times for a professional at a location: hours, minus blocks, minus holidays,
 * minus what is already occupied, in the location's zone. The same function answers the
 * availability endpoint and the "next free slots" of a conflict.
 */
export async function freeSlots(
  ports: SchedulingPorts,
  request: FreeSlotsRequest,
): Promise<TimeRange[]> {
  const zone = request.location.timeZone;
  const firstDate = localParts(zone, new Date(request.from)).date;
  const lastDate = new Date(Date.parse(`${firstDate}T00:00:00Z`) + request.days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const horizon: TimeRange = {
    start: dayBounds(zone, firstDate).start.getTime(),
    end: dayBounds(zone, lastDate).end.getTime(),
  };

  const hours = await ports.hours(request.professionalId, request.location.id, firstDate, lastDate);
  const blocks = await ports.blocks(request.professionalId, request.location.id, horizon);
  const holidays = await ports.holidays(firstDate, lastDate);
  const everywhere = await ports.occupancies(request.professionalId, horizon);
  // Time taken at another location rules the range out, whatever the capacity.
  const occupancies = everywhere.filter((other) => other.locationId === request.location.id);
  const elsewhere = everywhere
    .filter((other) => other.locationId !== request.location.id)
    .map((other) => ({ start: other.start, end: other.end }));

  const closedDates = new Set(
    datesBetween(firstDate, lastDate).filter(
      (date) => isClosedDay(holidays, date, request.location.id) !== null,
    ),
  );
  const windows = subtractRanges(
    workingWindows({
      zone,
      locationId: request.location.id,
      dates: datesBetween(firstDate, lastDate).filter((date) => !closedDates.has(date)),
      weekly: hours.weekly,
      periods: hours.periods,
    }),
    blocks,
  );

  return findFreeSlots({
    windows,
    occupancies,
    capacity: request.maxSimultaneous,
    durationMs: request.durationMinutes * 60_000,
    bufferMs: request.bufferMinutes * 60_000,
    stepMs: (request.stepMinutes ?? 15) * 60_000,
    notBefore: request.from,
    limit: request.limit,
    forbidden: elsewhere,
    ...(request.capacityOne === undefined ? {} : { capacityOne: request.capacityOne }),
  });
}

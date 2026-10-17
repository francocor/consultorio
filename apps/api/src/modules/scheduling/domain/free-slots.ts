import { assignLane, overlaps, relane, type Occupancy } from './lanes.js';
import type { TimeRange } from './working-hours.js';

export interface FreeSlotsInput {
  /** When the professional works and nothing blocks the calendar (hours minus blocks minus holidays). */
  windows: readonly TimeRange[];
  /** Active occupancies of the professional: appointments and holds, buffers included. */
  occupancies: readonly Occupancy[];
  /** Simultaneous appointments allowed (1 unless overbooking is on). */
  capacity: number;
  durationMs: number;
  bufferMs: number;
  /** Distance between candidate starts, counted from the start of each window. */
  stepMs: number;
  /** Nothing earlier than this is offered (now, for a booking). */
  notBefore: number;
  limit: number;
  /**
   * Public flows (online booking, waitlist offers) use capacity 1 whatever the professional allows:
   * a slot is free only when NOTHING occupies any part of the range.
   */
  capacityOne?: boolean;
}

/**
 * The free appointment times for a professional: every start on the step grid of a window where the
 * appointment fits inside the window and its occupied range (appointment plus buffer) fits the
 * professional's capacity at every instant. Returns the appointment range, without the buffer.
 * Pure and ordered by time, so the same function answers the availability endpoint and the "next
 * free slots" of a conflict.
 */
export function findFreeSlots(input: FreeSlotsInput): TimeRange[] {
  const slots: TimeRange[] = [];
  const { durationMs, stepMs } = input;
  if (input.limit <= 0 || stepMs <= 0 || durationMs <= 0) return slots;

  const fits = (start: number): boolean => {
    const occupied = { start, end: start + durationMs + input.bufferMs };
    if (input.capacityOne) {
      return !input.occupancies.some((other) => overlaps(other, occupied));
    }
    return (
      assignLane(input.occupancies, occupied, input.capacity) !== null ||
      relane(input.occupancies, occupied, input.capacity) !== null
    );
  };

  for (const window of [...input.windows].sort((a, b) => a.start - b.start)) {
    const earliest = Math.max(window.start, input.notBefore);
    const first = window.start + Math.ceil((earliest - window.start) / stepMs) * stepMs;
    for (let start = first; start + durationMs <= window.end; start += stepMs) {
      if (!fits(start)) continue;
      slots.push({ start, end: start + durationMs });
      if (slots.length >= input.limit) return slots;
    }
  }
  return slots;
}

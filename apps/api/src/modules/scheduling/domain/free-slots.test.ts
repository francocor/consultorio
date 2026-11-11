import { describe, expect, it } from 'vitest';

import { findFreeSlots } from './free-slots.js';
import type { Occupancy } from './lanes.js';

const m = (minutes: number) => minutes * 60_000;
/** Minutes after 08:00 UTC. */
const at = (minutes: number) => Date.parse('2026-07-13T08:00:00Z') + m(minutes);
const window = (from: number, to: number) => ({ start: at(from), end: at(to) });
const occ = (id: string, from: number, to: number, lane = 1): Occupancy => ({
  id,
  start: at(from),
  end: at(to),
  lane,
});
const starts = (slots: { start: number }[]) => slots.map((slot) => (slot.start - at(0)) / 60_000);

const base = {
  windows: [window(60, 180)], // 09:00-11:00
  occupancies: [] as Occupancy[],
  capacity: 1,
  durationMs: m(30),
  bufferMs: 0,
  stepMs: m(30),
  notBefore: Number.NEGATIVE_INFINITY,
  limit: 50,
};

describe('findFreeSlots', () => {
  it('offers every slot of the window, in order', () => {
    expect(starts(findFreeSlots(base))).toEqual([60, 90, 120, 150]);
  });

  it('returns the appointment range, without the buffer', () => {
    const [first] = findFreeSlots({ ...base, bufferMs: m(10) });

    expect(first).toEqual({ start: at(60), end: at(90) });
  });

  it('excludes slots that overlap an occupancy, and keeps back to back', () => {
    const slots = findFreeSlots({ ...base, occupancies: [occ('a', 90, 120)] });

    expect(starts(slots)).toEqual([60, 120, 150]);
  });

  it('counts the buffer of the new appointment against what comes after it', () => {
    // 09:00-09:30 plus a 10 minute buffer would reach 09:40, into the appointment at 09:30.
    const slots = findFreeSlots({ ...base, bufferMs: m(10), occupancies: [occ('a', 90, 120)] });

    expect(starts(slots)).toEqual([120, 150]);
  });

  it('counts the buffer of an occupancy that is already there (its range includes the buffer)', () => {
    // The existing appointment occupies until 09:40 including its buffer.
    const slots = findFreeSlots({ ...base, occupancies: [occ('a', 60, 100)], stepMs: m(10) });

    expect(starts(slots)).toEqual([100, 110, 120, 130, 140, 150]);
  });

  it('offers a slot inside capacity when overbooking is on, but not for public flows', () => {
    const busy = [occ('a', 90, 120)];

    expect(starts(findFreeSlots({ ...base, occupancies: busy, capacity: 2 }))).toEqual([
      60, 90, 120, 150,
    ]);
    expect(
      starts(findFreeSlots({ ...base, occupancies: busy, capacity: 2, capacityOne: true })),
    ).toEqual([60, 120, 150]);
  });

  it('finds room by re-laning when no single lane is free', () => {
    // Capacity 2: lane 1 holds 09:00-09:30, lane 2 holds 09:30-10:00; a visit 09:15-09:45 needs a re-lane.
    const slots = findFreeSlots({
      ...base,
      capacity: 2,
      stepMs: m(15),
      windows: [window(75, 105)],
      occupancies: [occ('x', 60, 90, 1), occ('y', 90, 120, 2)],
    });

    expect(starts(slots)).toEqual([75]);
  });

  it('never offers more simultaneous visits than the capacity', () => {
    const slots = findFreeSlots({
      ...base,
      capacity: 2,
      occupancies: [occ('a', 60, 120, 1), occ('b', 60, 120, 2)],
    });

    expect(starts(slots)).toEqual([120, 150]);
  });

  it('only offers slots that fit entirely inside a window', () => {
    const slots = findFreeSlots({ ...base, windows: [window(60, 100)] });

    expect(starts(slots)).toEqual([60]);
  });

  it('works across several windows and aligns the step to the start of each', () => {
    const slots = findFreeSlots({
      ...base,
      windows: [window(65, 125), window(200, 260)],
      stepMs: m(30),
    });

    expect(starts(slots)).toEqual([65, 95, 200, 230]);
  });

  it('refuses a start whose occupied range touches a forbidden range (the professional is elsewhere)', () => {
    const elsewhere = [window(90, 120)];

    expect(starts(findFreeSlots({ ...base, forbidden: elsewhere, capacity: 3 }))).toEqual([
      60, 120, 150,
    ]);
    // Its own buffer counts too: 09:00-09:30 plus ten minutes would reach 09:40.
    expect(
      starts(findFreeSlots({ ...base, forbidden: elsewhere, bufferMs: m(10), capacity: 3 })),
    ).toEqual([120, 150]);
  });

  it('skips the past and respects the limit', () => {
    expect(starts(findFreeSlots({ ...base, notBefore: at(80) }))).toEqual([90, 120, 150]);
    expect(starts(findFreeSlots({ ...base, limit: 2 }))).toEqual([60, 90]);
    expect(findFreeSlots({ ...base, limit: 0 })).toEqual([]);
  });

  it('rounds the first slot after notBefore up to the step grid of the window', () => {
    expect(starts(findFreeSlots({ ...base, notBefore: at(61), stepMs: m(15) }))).toEqual([
      75, 90, 105, 120, 135, 150,
    ]);
  });
});

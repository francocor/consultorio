import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { assignLane, maxOverlap, overlaps, relane, type Occupancy } from './lanes.js';

/** Minutes from 10:00 to ms, so the tables read like a calendar. */
const m = (minutes: number) => minutes * 60_000;
const occ = (id: string, from: number, to: number, lane: number): Occupancy => ({
  id,
  start: m(from),
  end: m(to),
  lane,
});
const range = (from: number, to: number) => ({ start: m(from), end: m(to) });

describe('overlaps', () => {
  it.each([
    [0, 30, 15, 45, true],
    [0, 30, 30, 60, false], // back to back
    [0, 30, 31, 60, false],
    [0, 30, 10, 20, true], // contained
    [10, 20, 0, 30, true],
    [0, 30, 0, 30, true],
  ])('(%i,%i) with (%i,%i) is %s', (a1, a2, b1, b2, expected) => {
    expect(overlaps(range(a1, a2), range(b1, b2))).toBe(expected);
  });
});

describe('assignLane', () => {
  it('gives lane 1 to the first appointment of a professional', () => {
    expect(assignLane([], range(0, 30), 1)).toBe(1);
  });

  it('gives lane 1 back when the only neighbour touches the range (back to back)', () => {
    expect(assignLane([occ('a', 0, 30, 1)], range(30, 60), 1)).toBe(1);
  });

  it('refuses an overlap when the professional cannot overbook', () => {
    expect(assignLane([occ('a', 0, 30, 1)], range(15, 45), 1)).toBeNull();
  });

  it('uses the lowest free lane up to the capacity', () => {
    const existing = [occ('a', 0, 30, 1)];

    expect(assignLane(existing, range(0, 30), 2)).toBe(2);
    expect(assignLane([...existing, occ('b', 0, 30, 2)], range(0, 30), 2)).toBeNull();
    expect(assignLane([...existing, occ('b', 0, 30, 2)], range(0, 30), 3)).toBe(3);
  });

  it('skips a lane that is busy and takes a free one below the highest', () => {
    const existing = [occ('a', 0, 30, 1), occ('c', 0, 30, 3)];

    expect(assignLane(existing, range(10, 20), 3)).toBe(2);
  });

  it('ignores occupancies that do not overlap the range, whatever their lane', () => {
    const existing = [occ('a', 100, 130, 1), occ('b', -60, -30, 2)];

    expect(assignLane(existing, range(0, 30), 2)).toBe(1);
  });

  it('is decided instant by instant: three appointments are fine if never more than two at once', () => {
    // 10:00-10:30 and 10:30-11:00 in lane 1 and one 10:15-10:45 in lane 2.
    const existing = [occ('a', 0, 30, 1), occ('b', 30, 60, 1), occ('c', 15, 45, 2)];

    expect(assignLane(existing, range(60, 90), 2)).toBe(1);
    expect(assignLane(existing, range(20, 40), 2)).toBeNull();
  });
});

describe('relane (capacity allows it but no single lane is free)', () => {
  it('moves one appointment to another lane to make room', () => {
    // Capacity 2. Lane 1 holds 0-30, lane 2 holds 30-60 (lane 1 was free then). A booking at
    // 15-45 overlaps both, so no lane is free as things stand; re-laned, it fits.
    const existing = [occ('x', 0, 30, 1), occ('y', 30, 60, 2)];

    expect(assignLane(existing, range(15, 45), 2)).toBeNull();
    const result = relane(existing, range(15, 45), 2);

    expect(result).not.toBeNull();
    expect(result?.moves).toEqual([{ id: 'y', lane: 1 }]);
    expect(result?.lane).toBe(2);
  });

  it('needs no move when a lane is already free', () => {
    const result = relane([occ('x', 0, 30, 1)], range(10, 20), 2);

    expect(result).toEqual({ lane: 2, moves: [] });
  });

  it('answers null when more would be simultaneous than the capacity', () => {
    const existing = [occ('x', 0, 60, 1), occ('y', 0, 60, 2)];

    expect(relane(existing, range(30, 40), 2)).toBeNull();
  });

  it('follows a chain of overlaps and keeps appointments in their lane when it can', () => {
    // Capacity 2: a (0-20, lane 1), b (20-40, lane 2), c (40-60, lane 1) and new 10-50.
    const existing = [occ('a', 0, 20, 1), occ('b', 20, 40, 2), occ('c', 40, 60, 1)];

    const result = relane(existing, range(10, 50), 2);

    expect(result).not.toBeNull();
    // The new one overlaps all three; they can never need more than two lanes at once.
    const lanes = new Map(existing.map((o) => [o.id, o.lane]));
    for (const move of result?.moves ?? []) lanes.set(move.id, move.lane);
    const all = [
      ...existing.map((o) => ({ ...o, lane: lanes.get(o.id) ?? o.lane })),
      { id: 'new', start: m(10), end: m(50), lane: result?.lane ?? 0 },
    ];
    for (const first of all) {
      for (const second of all) {
        if (first.id < second.id && first.lane === second.lane) {
          expect(overlaps(first, second)).toBe(false);
        }
      }
    }
  });

  it('does not touch appointments outside the chain of overlaps', () => {
    const existing = [occ('far', 200, 230, 2), occ('x', 0, 30, 1), occ('y', 30, 60, 2)];

    const result = relane(existing, range(15, 45), 2);

    expect(result?.moves.map((move) => move.id)).not.toContain('far');
  });
});

describe('maxOverlap', () => {
  it('counts simultaneous intervals, treating end and start of neighbours as not overlapping', () => {
    expect(maxOverlap([range(0, 30), range(30, 60)])).toBe(1);
    expect(maxOverlap([range(0, 30), range(15, 45), range(20, 40)])).toBe(3);
    expect(maxOverlap([])).toBe(0);
  });
});

describe('properties (fast-check)', () => {
  const interval = fc
    .record({ start: fc.integer({ min: 0, max: 120 }), length: fc.integer({ min: 1, max: 60 }) })
    .map(({ start, length }) => ({ start: m(start), end: m(start + length) }));

  /** Inserts the intervals one by one like the booking service does. */
  function book(intervals: readonly { start: number; end: number }[], capacity: number) {
    let placed: Occupancy[] = [];
    const refused: { start: number; end: number }[] = [];
    intervals.forEach((candidate, index) => {
      const lane = assignLane(placed, candidate, capacity);
      if (lane !== null) {
        placed.push({ id: String(index), ...candidate, lane });
        return;
      }
      const result = relane(placed, candidate, capacity);
      if (result === null) {
        refused.push(candidate);
        return;
      }
      const moves = new Map(result.moves.map((move) => [move.id, move.lane]));
      placed = placed.map((o) => ({ ...o, lane: moves.get(o.id) ?? o.lane }));
      placed.push({ id: String(index), ...candidate, lane: result.lane });
    });
    return { placed, refused };
  }

  it('never puts two overlapping appointments in one lane and never exceeds the capacity', () => {
    fc.assert(
      fc.property(
        fc.array(interval, { maxLength: 25 }),
        fc.integer({ min: 1, max: 4 }),
        (list, capacity) => {
          const { placed } = book(list, capacity);
          return placed.every(
            (first, i) =>
              first.lane >= 1 &&
              first.lane <= capacity &&
              placed.every(
                (second, j) => j <= i || first.lane !== second.lane || !overlaps(first, second),
              ),
          );
        },
      ),
      { numRuns: 300 },
    );
  });

  it('refuses a booking only when more than the capacity would be simultaneous (relane fits whenever feasible)', () => {
    fc.assert(
      fc.property(
        fc.array(interval, { maxLength: 25 }),
        fc.integer({ min: 1, max: 4 }),
        (list, capacity) => {
          const { placed, refused } = book(list, capacity);
          return refused.every((candidate) => maxOverlap([...placed, candidate]) > capacity);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('accepts everything when the whole set never exceeds the capacity', () => {
    fc.assert(
      fc.property(fc.array(interval, { maxLength: 25 }), (list) => {
        const capacity = Math.max(1, maxOverlap(list));
        const { refused } = book(list, capacity);
        return refused.length === 0;
      }),
      { numRuns: 300 },
    );
  });

  it('moves only appointments that overlap the chain of the new one', () => {
    fc.assert(
      fc.property(fc.array(interval, { maxLength: 12 }), interval, (list, candidate) => {
        const { placed } = book(list, 3);
        const result = relane(placed, candidate, 3);
        if (result === null) return true;
        const chain = new Set<string>();
        let frontier: { start: number; end: number }[] = [candidate];
        while (frontier.length > 0) {
          const next: { start: number; end: number }[] = [];
          for (const o of placed) {
            if (!chain.has(o.id) && frontier.some((f) => overlaps(f, o))) {
              chain.add(o.id);
              next.push(o);
            }
          }
          frontier = next;
        }
        return result.moves.every((move) => chain.has(move.id));
      }),
      { numRuns: 300 },
    );
  });
});

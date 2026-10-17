/**
 * Lanes: how overbooking is represented (design 4.6). A professional has `capacity` lanes (1 unless
 * overbooking is on). An occupancy takes one lane for its whole range, and two occupancies of one
 * lane may not overlap; the database enforces that with an exclusion constraint, and these pure
 * functions pick the lane before the write.
 *
 * Ranges are half open `[start, end)` and `end` already includes the buffer, so an appointment that
 * starts exactly when another one's range ends does not overlap it.
 */

export interface Range {
  start: number;
  end: number;
}

export interface Occupancy extends Range {
  id: string;
  /** 1-based. */
  lane: number;
}

export function overlaps(a: Range, b: Range): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * The lowest lane in `1..capacity` that no overlapping occupancy uses, or null when every lane is
 * taken somewhere inside the range.
 */
export function assignLane(
  existing: readonly Occupancy[],
  range: Range,
  capacity: number,
): number | null {
  const taken = new Set(existing.filter((other) => overlaps(other, range)).map((o) => o.lane));
  for (let lane = 1; lane <= capacity; lane += 1) {
    if (!taken.has(lane)) return lane;
  }
  return null;
}

/** The most occupancies that are ever simultaneous (a sweep over the starts and ends). */
export function maxOverlap(ranges: readonly Range[]): number {
  const events = ranges.flatMap((r) => [
    { at: r.start, delta: 1 },
    { at: r.end, delta: -1 },
  ]);
  // At the same instant an end comes before a start: touching ranges do not overlap.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let current = 0;
  let best = 0;
  for (const event of events) {
    current += event.delta;
    best = Math.max(best, current);
  }
  return best;
}

export interface LaneMove {
  id: string;
  lane: number;
}

export interface RelaneResult {
  /** The lane for the new range. */
  lane: number;
  /** Existing occupancies that change lane to make room. */
  moves: LaneMove[];
}

/**
 * Makes room by moving occupancies between lanes when capacity allows it but no single lane is
 * free for the new range. It works on the chain of occupancies connected to the new range through
 * overlaps (nothing else is touched) and lays them out greedily by start time, which uses the
 * fewest lanes possible for intervals: it succeeds exactly when never more than `capacity` of them
 * are simultaneous. Occupancies keep their lane whenever it is free for them, so few move.
 * Returns null when the capacity would be exceeded.
 */
export function relane(
  existing: readonly Occupancy[],
  range: Range,
  capacity: number,
): RelaneResult | null {
  const NEW = '\u0000new';
  const chain = new Set<string>();
  let frontier: Range[] = [range];
  while (frontier.length > 0) {
    const next: Occupancy[] = [];
    for (const other of existing) {
      if (!chain.has(other.id) && frontier.some((member) => overlaps(member, other))) {
        chain.add(other.id);
        next.push(other);
      }
    }
    frontier = next;
  }

  const items: (Range & { id: string; lane: number })[] = [
    ...existing.filter((other) => chain.has(other.id)),
    { id: NEW, ...range, lane: 0 },
  ];
  // By start; existing ones before the new one at a tie, so the new one takes what is left.
  items.sort((a, b) => a.start - b.start || (a.id === NEW ? 1 : 0) - (b.id === NEW ? 1 : 0));

  const busyUntil = new Array<number>(capacity + 1).fill(Number.NEGATIVE_INFINITY);
  const placed = new Map<string, number>();
  for (const item of items) {
    const isFree = (lane: number) => (busyUntil[lane] ?? Number.NEGATIVE_INFINITY) <= item.start;
    let lane = item.lane >= 1 && item.lane <= capacity && isFree(item.lane) ? item.lane : 0;
    for (let candidate = 1; lane === 0 && candidate <= capacity; candidate += 1) {
      if (isFree(candidate)) lane = candidate;
    }
    if (lane === 0) return null;
    busyUntil[lane] = item.end;
    placed.set(item.id, lane);
  }

  const moves = existing.flatMap((other) => {
    const lane = placed.get(other.id);
    return lane !== undefined && lane !== other.lane ? [{ id: other.id, lane }] : [];
  });
  return { lane: placed.get(NEW) ?? 1, moves };
}

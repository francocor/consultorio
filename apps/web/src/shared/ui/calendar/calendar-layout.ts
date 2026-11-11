/**
 * Pure geometry of the time grid: how overlapping appointments share a column, and how a pointer
 * position becomes a time. Kept free of React and of the DOM so it is tested with plain numbers.
 */

export interface Span {
  id: string;
  /** Minutes since local midnight. */
  start: number;
  end: number;
}

export interface Placement {
  /** Which of the side-by-side lanes the appointment sits in (0 is the leftmost). */
  lane: number;
  /** How many lanes the group it belongs to needs. */
  lanes: number;
}

/**
 * Places spans side by side so none covers another. Spans that touch only at an end do not
 * overlap. Every span of a connected group shares the group's lane count, so the widths agree.
 */
export function layoutOverlaps(spans: readonly Span[]): Record<string, Placement> {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const result: Record<string, Placement> = {};

  let group: { id: string; lane: number }[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;

  const closeGroup = () => {
    for (const item of group) result[item.id] = { lane: item.lane, lanes: laneEnds.length };
    group = [];
    laneEnds = [];
  };

  for (const span of sorted) {
    if (span.start >= groupEnd) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= span.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.end);
    } else {
      laneEnds[lane] = span.end;
    }
    group.push({ id: span.id, lane });
    groupEnd = Math.max(groupEnd, span.end);
  }
  closeGroup();
  return result;
}

export function snapMinutes(minutes: number, step: number): number {
  return Math.round(minutes / step) * step;
}

/** The snapped minute of the day under a vertical position inside the grid body. */
export function minutesFromOffset(input: {
  offsetY: number;
  pxPerMinute: number;
  startMinute: number;
  step: number;
}): number {
  const raw = input.startMinute + input.offsetY / input.pxPerMinute;
  return Math.max(input.startMinute, snapMinutes(raw, input.step));
}

/** The column under a horizontal position, kept inside the first and last column. */
export function columnIndexFromX(input: {
  x: number;
  left: number;
  width: number;
  columns: number;
}): number {
  const index = Math.floor(((input.x - input.left) / input.width) * input.columns);
  return Math.min(Math.max(index, 0), input.columns - 1);
}

/**
 * The hours the grid shows: the default range, widened to whole hours so that no appointment is
 * cut off at the top or bottom.
 */
export function visibleHours(
  spans: readonly { start: number; end: number }[],
  fallback: { start: number; end: number },
): { start: number; end: number } {
  let start = fallback.start;
  let end = fallback.end;
  for (const span of spans) {
    start = Math.min(start, Math.floor(span.start / 60));
    end = Math.max(end, Math.ceil(span.end / 60));
  }
  return { start: Math.max(start, 0), end: Math.min(end, 24) };
}

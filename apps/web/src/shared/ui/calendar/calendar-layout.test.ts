import { describe, expect, it } from 'vitest';

import {
  columnIndexFromX,
  layoutOverlaps,
  minutesFromOffset,
  snapMinutes,
  visibleHours,
} from './calendar-layout.js';

describe('layoutOverlaps', () => {
  it('gives a lone appointment the whole column', () => {
    expect(layoutOverlaps([{ id: 'a', start: 540, end: 570 }])).toEqual({
      a: { lane: 0, lanes: 1 },
    });
  });

  it('keeps back-to-back appointments in one lane', () => {
    const placed = layoutOverlaps([
      { id: 'a', start: 540, end: 570 },
      { id: 'b', start: 570, end: 600 },
    ]);

    expect(placed['a']).toEqual({ lane: 0, lanes: 1 });
    expect(placed['b']).toEqual({ lane: 0, lanes: 1 });
  });

  it('puts two overlapping appointments side by side', () => {
    const placed = layoutOverlaps([
      { id: 'a', start: 540, end: 600 },
      { id: 'b', start: 570, end: 630 },
    ]);

    expect(placed['a']).toEqual({ lane: 0, lanes: 2 });
    expect(placed['b']).toEqual({ lane: 1, lanes: 2 });
  });

  it('reuses a free lane inside one group and shares the width of the whole group', () => {
    // a overlaps b, b overlaps c, a and c do not: c goes back to lane 0 of a group of two.
    const placed = layoutOverlaps([
      { id: 'a', start: 540, end: 600 },
      { id: 'b', start: 570, end: 660 },
      { id: 'c', start: 600, end: 630 },
    ]);

    expect(placed['a']).toEqual({ lane: 0, lanes: 2 });
    expect(placed['b']).toEqual({ lane: 1, lanes: 2 });
    expect(placed['c']).toEqual({ lane: 0, lanes: 2 });
  });

  it('does not widen an unrelated appointment later in the day', () => {
    const placed = layoutOverlaps([
      { id: 'a', start: 540, end: 600 },
      { id: 'b', start: 540, end: 600 },
      { id: 'c', start: 720, end: 780 },
    ]);

    expect(placed['a']?.lanes).toBe(2);
    expect(placed['c']).toEqual({ lane: 0, lanes: 1 });
  });

  it('handles three simultaneous appointments (overbooking of three)', () => {
    const placed = layoutOverlaps([
      { id: 'a', start: 540, end: 600 },
      { id: 'b', start: 540, end: 600 },
      { id: 'c', start: 540, end: 600 },
    ]);

    expect(Object.values(placed).map((item) => item.lane)).toEqual([0, 1, 2]);
    expect(Object.values(placed).every((item) => item.lanes === 3)).toBe(true);
  });
});

describe('snapMinutes', () => {
  it('rounds to the nearest step', () => {
    expect(snapMinutes(547, 15)).toBe(540);
    expect(snapMinutes(548, 15)).toBe(555);
    expect(snapMinutes(540, 15)).toBe(540);
  });
});

describe('minutesFromOffset', () => {
  it('turns a vertical position inside the grid into snapped minutes of the day', () => {
    // 1 px per minute, the grid starts at 07:00 (420), 15-minute steps.
    expect(minutesFromOffset({ offsetY: 130, pxPerMinute: 1, startMinute: 420, step: 15 })).toBe(
      555,
    );
    expect(minutesFromOffset({ offsetY: 0, pxPerMinute: 1, startMinute: 420, step: 15 })).toBe(420);
  });

  it('works with a scaled grid', () => {
    expect(minutesFromOffset({ offsetY: 72, pxPerMinute: 1.2, startMinute: 420, step: 15 })).toBe(
      480,
    );
  });

  it('never goes before the start of the grid', () => {
    expect(minutesFromOffset({ offsetY: -50, pxPerMinute: 1, startMinute: 420, step: 15 })).toBe(
      420,
    );
  });
});

describe('columnIndexFromX', () => {
  it('finds the column under the pointer', () => {
    expect(columnIndexFromX({ x: 250, left: 100, width: 400, columns: 4 })).toBe(1);
    expect(columnIndexFromX({ x: 101, left: 100, width: 400, columns: 4 })).toBe(0);
  });

  it('clamps to the first and last column', () => {
    expect(columnIndexFromX({ x: 20, left: 100, width: 400, columns: 4 })).toBe(0);
    expect(columnIndexFromX({ x: 900, left: 100, width: 400, columns: 4 })).toBe(3);
  });
});

describe('visibleHours', () => {
  it('uses the default range when the day fits in it', () => {
    expect(visibleHours([{ start: 540, end: 600 }], { start: 7, end: 21 })).toEqual({
      start: 7,
      end: 21,
    });
  });

  it('widens the range to show an early or late appointment', () => {
    expect(
      visibleHours(
        [
          { start: 5 * 60 + 30, end: 6 * 60 },
          { start: 21 * 60 + 30, end: 22 * 60 + 15 },
        ],
        { start: 7, end: 21 },
      ),
    ).toEqual({ start: 5, end: 23 });
  });
});

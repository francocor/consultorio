import { describe, expect, it } from 'vitest';

import { OVERDUE_AFTER_MINUTES, isOverdue, scanBackoffSeconds } from './scan-schedule.js';

describe('scanBackoffSeconds: how long to wait before asking the scanner again', () => {
  it('starts at 30 seconds and doubles with every failed attempt', () => {
    expect([1, 2, 3, 4, 5].map(scanBackoffSeconds)).toEqual([30, 60, 120, 240, 480]);
  });

  it('never waits more than 15 minutes, however long the outage lasts', () => {
    expect(scanBackoffSeconds(6)).toBe(900);
    expect(scanBackoffSeconds(50)).toBe(900);
    expect(scanBackoffSeconds(10_000)).toBe(900);
  });

  it('treats a nonsensical attempt count as the first one', () => {
    expect(scanBackoffSeconds(0)).toBe(30);
    expect(scanBackoffSeconds(-3)).toBe(30);
    expect(scanBackoffSeconds(Number.NaN)).toBe(30);
  });
});

describe('isOverdue: when a waiting document becomes an alert', () => {
  const confirmed = new Date('2026-03-02T10:00:00Z');

  it('is not overdue before an hour, and is from one hour on', () => {
    expect(OVERDUE_AFTER_MINUTES).toBe(60);
    expect(isOverdue(confirmed, new Date('2026-03-02T10:59:59Z'))).toBe(false);
    expect(isOverdue(confirmed, new Date('2026-03-02T11:00:00Z'))).toBe(true);
    expect(isOverdue(confirmed, new Date('2026-03-03T10:00:00Z'))).toBe(true);
  });
});

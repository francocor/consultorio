import { describe, expect, it } from 'vitest';

import {
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  ageInMinutes,
  backoffMs,
  isOutageFlagged,
} from './retry-schedule.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('the backoff of a pending invoice (design 5.5: 1 minute up to 6 hours)', () => {
  it('starts at one minute and doubles with every attempt', () => {
    expect([1, 2, 3, 4, 5].map((attempts) => backoffMs(attempts) / MINUTE)).toEqual([
      1, 2, 4, 8, 16,
    ]);
  });

  it('never goes above six hours, however many attempts there were', () => {
    expect(backoffMs(9)).toBe(256 * MINUTE);
    expect(backoffMs(10)).toBe(6 * HOUR);
    expect(backoffMs(11)).toBe(6 * HOUR);
    expect(backoffMs(500)).toBe(MAX_BACKOFF_MS);
  });

  it('treats a count below one as the first attempt', () => {
    expect(backoffMs(0)).toBe(MIN_BACKOFF_MS);
    expect(backoffMs(-3)).toBe(MIN_BACKOFF_MS);
  });
});

describe('the age of a pending invoice and the prolonged-outage flag', () => {
  const created = new Date('2031-03-01T10:00:00Z');

  it('counts whole minutes since the request', () => {
    expect(ageInMinutes(created, new Date('2031-03-01T10:00:59Z'))).toBe(0);
    expect(ageInMinutes(created, new Date('2031-03-01T10:01:00Z'))).toBe(1);
    expect(ageInMinutes(created, new Date('2031-03-02T10:00:00Z'))).toBe(1440);
  });

  it('never counts a negative age (a clock a little behind)', () => {
    expect(ageInMinutes(created, new Date('2031-03-01T09:59:00Z'))).toBe(0);
  });

  it('flags a pending invoice from the threshold on, and not before', () => {
    const threshold = 24;
    expect(isOutageFlagged('pending', 24 * 60 - 1, threshold)).toBe(false);
    expect(isOutageFlagged('pending', 24 * 60, threshold)).toBe(true);
    expect(isOutageFlagged('pending', 3 * 24 * 60, threshold)).toBe(true);
  });

  it('follows the threshold of the organization', () => {
    expect(isOutageFlagged('pending', 3 * 60, 2)).toBe(true);
    expect(isOutageFlagged('pending', 90, 2)).toBe(false);
  });

  it('flags nothing that is not pending: an old issued invoice is just old', () => {
    expect(isOutageFlagged('issued', 100 * 60, 24)).toBe(false);
    expect(isOutageFlagged('rejected', 100 * 60, 24)).toBe(false);
    expect(isOutageFlagged('manual', 100 * 60, 24)).toBe(false);
  });
});

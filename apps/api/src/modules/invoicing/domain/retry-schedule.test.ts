import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTLE_MS,
  MAX_AWAITING_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  ageInMinutes,
  awaitingBackoffMs,
  backoffMs,
  isOutageFlagged,
  isAttemptAudited,
  isSettled,
  isStalled,
  settleMsOf,
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

describe('the backoff of an invoice that waits for reconciliation (JD-S4 R3-1)', () => {
  it('follows the ordinary schedule up to five minutes and never waits longer', () => {
    expect([1, 2, 3, 4, 5].map((attempts) => awaitingBackoffMs(attempts) / MINUTE)).toEqual([
      1, 2, 4, 5, 5,
    ]);
    expect(awaitingBackoffMs(500)).toBe(MAX_AWAITING_BACKOFF_MS);
    expect(MAX_AWAITING_BACKOFF_MS).toBe(5 * MINUTE);
  });
});

describe('when an invoice that waits for reconciliation counts as stalled (JD-S4 R3-2, R4-B-S1)', () => {
  const since = new Date('2031-05-20T10:00:00Z');
  const at = (minutes: number) => new Date(since.getTime() + minutes * MINUTE);

  it('is stalled two hours after it began to wait, and not before', () => {
    expect(isStalled({ awaitingSince: since, now: at(119) })).toBe(false);
    expect(isStalled({ awaitingSince: since, now: at(120) })).toBe(true);
    expect(isStalled({ awaitingSince: since, now: at(600) })).toBe(true);
  });

  it('does not count a clock that is behind the start of the wait', () => {
    expect(isStalled({ awaitingSince: since, now: at(-30) })).toBe(false);
  });
});

describe('which attempts are audited (JD-S4 R4)', () => {
  const at = (hours: number, minutes: number) => new Date(Date.UTC(2031, 4, 20, hours, minutes));

  it('audits the first six attempts, whenever they happen', () => {
    for (const attempt of [1, 2, 3, 4, 5, 6]) {
      expect(isAttemptAudited({ attempt, previousAttemptAt: at(10, 1), now: at(10, 2) })).toBe(
        true,
      );
    }
  });

  it('audits one attempt for each clock hour after that', () => {
    expect(isAttemptAudited({ attempt: 7, previousAttemptAt: at(10, 40), now: at(10, 45) })).toBe(
      false,
    );
    expect(isAttemptAudited({ attempt: 40, previousAttemptAt: at(10, 55), now: at(10, 59) })).toBe(
      false,
    );
    expect(isAttemptAudited({ attempt: 41, previousAttemptAt: at(10, 59), now: at(11, 4) })).toBe(
      true,
    );
  });

  it('audits an attempt that has no earlier one to compare with', () => {
    expect(isAttemptAudited({ attempt: 9, previousAttemptAt: null, now: at(10, 0) })).toBe(true);
  });
});

describe('when "nothing was issued" is believed (JD-S4 R6-1)', () => {
  const sent = new Date(Date.UTC(2031, 4, 20, 10, 0));
  const later = (minutes: number) => new Date(sent.getTime() + minutes * 60_000);

  it('is not believed before the settle time has passed since the request was sent', () => {
    expect(isSettled({ sentAt: sent, now: later(9), settleMs: DEFAULT_SETTLE_MS })).toBe(false);
    expect(isSettled({ sentAt: sent, now: later(10), settleMs: DEFAULT_SETTLE_MS })).toBe(true);
  });

  it('counts a request with no known time as settled: the pin is then the only guard', () => {
    expect(isSettled({ sentAt: null, now: sent, settleMs: DEFAULT_SETTLE_MS })).toBe(true);
  });

  it('takes the default for a setting that is not a finite, non-negative number', () => {
    expect(settleMsOf(undefined)).toBe(DEFAULT_SETTLE_MS);
    expect(settleMsOf(Number.NaN)).toBe(DEFAULT_SETTLE_MS);
    expect(settleMsOf(-5)).toBe(DEFAULT_SETTLE_MS);
    expect(settleMsOf(0)).toBe(0);
    expect(settleMsOf(90_000)).toBe(90_000);
    expect(DEFAULT_SETTLE_MS).toBe(10 * 60_000);
  });
});

import { describe, expect, it } from 'vitest';

import { canCancel, canConfirm, cancelDeadline } from './appointment-policy.js';

const STARTS = new Date('2031-05-12T13:00:00.000Z');
const at = (hoursBefore: number) => new Date(STARTS.getTime() - hoursBefore * 3_600_000);
const state = (overrides: Partial<Parameters<typeof canCancel>[0]> = {}) => ({
  status: 'scheduled' as const,
  startsAt: STARTS,
  now: at(48),
  deadlineHours: 12,
  ...overrides,
});

describe('the last moment to cancel', () => {
  it('is the cut-off of the organization before the start', () => {
    expect(cancelDeadline(STARTS, 12).toISOString()).toBe('2031-05-12T01:00:00.000Z');
    expect(cancelDeadline(STARTS, 0).toISOString()).toBe(STARTS.toISOString());
    expect(cancelDeadline(STARTS, 24).toISOString()).toBe('2031-05-11T13:00:00.000Z');
  });
});

describe('cancelling from the portal', () => {
  it('is allowed before the cut-off and refused from it on', () => {
    expect(canCancel(state({ now: at(13) }))).toBe(true);
    expect(canCancel(state({ now: at(12) }))).toBe(false);
    expect(canCancel(state({ now: at(2) }))).toBe(false);
  });

  it('follows the cut-off of the organization, not a fixed one', () => {
    expect(canCancel(state({ now: at(20), deadlineHours: 24 }))).toBe(false);
    expect(canCancel(state({ now: at(20), deadlineHours: 2 }))).toBe(true);
  });

  it('is for an appointment that is still open, and never for one that already started', () => {
    for (const status of ['pending_approval', 'scheduled', 'confirmed'] as const) {
      expect(canCancel(state({ status, now: at(48) })), status).toBe(true);
    }
    for (const status of [
      'cancelled',
      'attended',
      'no_show',
      'checked_in',
      'in_progress',
    ] as const) {
      expect(canCancel(state({ status, now: at(48) })), status).toBe(false);
    }
    expect(canCancel(state({ now: new Date(STARTS.getTime() + 60_000), deadlineHours: 0 }))).toBe(
      false,
    );
  });
});

describe('confirming from the portal', () => {
  it('is for a scheduled appointment that is still to come', () => {
    expect(canConfirm(state())).toBe(true);
    expect(canConfirm(state({ status: 'confirmed' }))).toBe(false);
    expect(canConfirm(state({ status: 'pending_approval' }))).toBe(false);
    expect(canConfirm(state({ status: 'cancelled' }))).toBe(false);
    expect(canConfirm(state({ now: new Date(STARTS.getTime() + 1) }))).toBe(false);
  });

  it('does not depend on the cut-off to cancel', () => {
    expect(canConfirm(state({ now: at(1) }))).toBe(true);
  });
});

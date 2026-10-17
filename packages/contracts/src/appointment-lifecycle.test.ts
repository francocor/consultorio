import { describe, expect, it } from 'vitest';

import {
  APPOINTMENT_TRANSITIONS,
  canRescheduleStatus,
  canTransitionStatus,
  isTerminalStatus,
  nextStatuses,
} from './appointment-lifecycle.js';
import { APPOINTMENT_STATUSES } from './scheduling.js';

describe('the shared lifecycle table', () => {
  it('has an entry for each of the eight statuses and no other', () => {
    expect(Object.keys(APPOINTMENT_TRANSITIONS).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
  });

  it('allows exactly the transitions of the scheduling spec', () => {
    expect(nextStatuses('pending_approval')).toEqual(['scheduled', 'cancelled']);
    expect(nextStatuses('scheduled')).toEqual(['confirmed', 'checked_in', 'no_show', 'cancelled']);
    expect(nextStatuses('confirmed')).toEqual(['checked_in', 'no_show', 'cancelled']);
    expect(nextStatuses('checked_in')).toEqual(['in_progress', 'no_show', 'cancelled']);
    expect(nextStatuses('in_progress')).toEqual(['attended']);
  });

  it('answers a pair question the same way as the table', () => {
    expect(canTransitionStatus('scheduled', 'checked_in')).toBe(true);
    expect(canTransitionStatus('checked_in', 'scheduled')).toBe(false);
    expect(canTransitionStatus('cancelled', 'checked_in')).toBe(false);
  });

  it('treats attended, no-show and cancelled as terminal', () => {
    expect(APPOINTMENT_STATUSES.filter(isTerminalStatus)).toEqual([
      'attended',
      'no_show',
      'cancelled',
    ]);
    expect(nextStatuses('attended')).toEqual([]);
  });

  it('lets an appointment be moved only before it has started', () => {
    expect(APPOINTMENT_STATUSES.filter(canRescheduleStatus)).toEqual([
      'pending_approval',
      'scheduled',
      'confirmed',
    ]);
  });
});

import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@consultorio/contracts';
import { describe, expect, it } from 'vitest';

import {
  canCorrect,
  canReschedule,
  canTransition,
  isTerminal,
  occupiesTime,
} from './appointment-state-machine.js';

/** The transition table of the scheduling spec ("Attendance lifecycle"), written out by hand. */
const ALLOWED: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  pending_approval: ['scheduled', 'cancelled'],
  scheduled: ['confirmed', 'checked_in', 'no_show', 'cancelled'],
  confirmed: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['in_progress', 'no_show', 'cancelled'],
  in_progress: ['attended'],
  attended: [],
  no_show: [],
  cancelled: [],
};

const PAIRS = APPOINTMENT_STATUSES.flatMap((from) =>
  APPOINTMENT_STATUSES.map((to) => [from, to] as const),
);

describe('the eight statuses', () => {
  it('are the only ones there are', () => {
    expect(APPOINTMENT_STATUSES).toHaveLength(8);
    expect(Object.keys(ALLOWED).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
  });
});

describe('canTransition (every from/to pair)', () => {
  it.each(PAIRS)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED[from].includes(to));
  });

  it('never lets a status move to itself', () => {
    for (const status of APPOINTMENT_STATUSES) expect(canTransition(status, status)).toBe(false);
  });

  it('has exactly 13 allowed transitions', () => {
    expect(PAIRS.filter(([from, to]) => canTransition(from, to))).toHaveLength(13);
  });
});

describe('terminal statuses', () => {
  it('are attended, no-show and cancelled, and nothing leaves them by a transition', () => {
    const terminal = APPOINTMENT_STATUSES.filter(isTerminal);

    expect(terminal).toEqual(['attended', 'no_show', 'cancelled']);
    for (const from of terminal) {
      for (const to of APPOINTMENT_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
  });
});

describe('occupiesTime', () => {
  it('is true for the six statuses that hold the professional, false for no-show and cancelled', () => {
    expect(APPOINTMENT_STATUSES.filter(occupiesTime)).toEqual([
      'pending_approval',
      'scheduled',
      'confirmed',
      'checked_in',
      'in_progress',
      'attended',
    ]);
  });
});

describe('canCorrect (an authorized correction of a terminal status)', () => {
  it('moves a terminal status to another real status', () => {
    expect(canCorrect('no_show', 'attended')).toBe(true);
    expect(canCorrect('cancelled', 'scheduled')).toBe(true);
    expect(canCorrect('attended', 'no_show')).toBe(true);
  });

  it('is not a way around the lifecycle for a status that is not terminal', () => {
    for (const from of APPOINTMENT_STATUSES.filter((status) => !isTerminal(status))) {
      for (const to of APPOINTMENT_STATUSES) expect(canCorrect(from, to)).toBe(false);
    }
  });

  it('never goes back to pending approval (that is only for online bookings) or stays put', () => {
    for (const from of APPOINTMENT_STATUSES.filter(isTerminal)) {
      expect(canCorrect(from, 'pending_approval')).toBe(false);
      expect(canCorrect(from, from)).toBe(false);
    }
  });
});

describe('canReschedule', () => {
  it('allows an appointment that has not started', () => {
    expect(APPOINTMENT_STATUSES.filter(canReschedule)).toEqual([
      'pending_approval',
      'scheduled',
      'confirmed',
    ]);
  });

  it('refuses an attended appointment', () => {
    expect(canReschedule('attended')).toBe(false);
  });
});

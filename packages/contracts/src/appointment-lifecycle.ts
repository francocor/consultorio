import { APPOINTMENT_STATUSES, type AppointmentStatus } from './scheduling.js';

/**
 * The attendance lifecycle (scheduling, "Attendance lifecycle"): eight statuses and the moves
 * between them. The API enforces it and the screens read the very same table to offer only the
 * actions that can succeed, so the two cannot drift apart. "Rescheduled" is not a status; it is an
 * event in the history.
 */
export const APPOINTMENT_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  pending_approval: ['scheduled', 'cancelled'],
  scheduled: ['confirmed', 'checked_in', 'no_show', 'cancelled'],
  confirmed: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['in_progress', 'no_show', 'cancelled'],
  in_progress: ['attended'],
  attended: [],
  no_show: [],
  cancelled: [],
};

/** The statuses an appointment may move to from `from` by an ordinary transition. */
export function nextStatuses(from: AppointmentStatus): readonly AppointmentStatus[] {
  return APPOINTMENT_TRANSITIONS[from];
}

export function canTransitionStatus(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[from].includes(to);
}

/** Nothing leaves these by an ordinary transition; only an authorized correction can. */
export function isTerminalStatus(status: AppointmentStatus): boolean {
  return APPOINTMENT_TRANSITIONS[status].length === 0;
}

/** An appointment can be moved while it has not started: not once checked in, never once terminal. */
export function canRescheduleStatus(status: AppointmentStatus): boolean {
  return status === 'pending_approval' || status === 'scheduled' || status === 'confirmed';
}

/** Every status, in lifecycle order (for legends and filters). */
export const LIFECYCLE_ORDER: readonly AppointmentStatus[] = APPOINTMENT_STATUSES;

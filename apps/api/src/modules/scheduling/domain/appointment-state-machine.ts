import { APPOINTMENT_STATUSES, type AppointmentStatus } from '@consultorio/contracts';

/**
 * The attendance lifecycle (scheduling, "Attendance lifecycle"): eight statuses and the transitions
 * between them. "Rescheduled" is not a status; it is an event in the history.
 */
const TRANSITIONS: Record<AppointmentStatus, readonly AppointmentStatus[]> = {
  pending_approval: ['scheduled', 'cancelled'],
  scheduled: ['confirmed', 'checked_in', 'no_show', 'cancelled'],
  confirmed: ['checked_in', 'no_show', 'cancelled'],
  checked_in: ['in_progress', 'no_show', 'cancelled'],
  in_progress: ['attended'],
  attended: [],
  no_show: [],
  cancelled: [],
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Nothing leaves these by an ordinary transition; only an authorized correction can. */
export function isTerminal(status: AppointmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

const OCCUPYING: ReadonlySet<AppointmentStatus> = new Set([
  'pending_approval',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'attended',
]);

/** Statuses in which the appointment holds the professional's time. No-show and cancelled free it. */
export function occupiesTime(status: AppointmentStatus): boolean {
  return OCCUPYING.has(status);
}

/**
 * An authorized correction moves a TERMINAL status to another real one (for example a no-show
 * marked by mistake). It never invents a pending approval, which exists only for online bookings.
 */
export function canCorrect(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return (
    isTerminal(from) &&
    from !== to &&
    to !== 'pending_approval' &&
    APPOINTMENT_STATUSES.includes(to)
  );
}

/** An appointment can be moved while it has not started: not once checked in, never once terminal. */
export function canReschedule(status: AppointmentStatus): boolean {
  return status === 'pending_approval' || status === 'scheduled' || status === 'confirmed';
}

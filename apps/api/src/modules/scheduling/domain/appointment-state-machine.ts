import {
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
  canRescheduleStatus,
  canTransitionStatus,
  isTerminalStatus,
} from '@consultorio/contracts';

/**
 * The attendance lifecycle (scheduling, "Attendance lifecycle") is one table in the contracts
 * package, read by the API here and by the screens, so the two cannot drift apart. "Rescheduled"
 * is not a status; it is an event in the history.
 */
export const canTransition = canTransitionStatus;

/** Nothing leaves these by an ordinary transition; only an authorized correction can. */
export const isTerminal = isTerminalStatus;

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
export const canReschedule = canRescheduleStatus;

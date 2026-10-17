import type { MessageCancelReason } from '@consultorio/contracts';

/**
 * Whether a queued message about an appointment is still worth sending when its time comes
 * (spec "Automatic reminders": nothing for a cancelled, attended or past appointment; a move
 * replaces the reminders). Pure: the caller reads the appointment and passes what it found.
 */

export interface PlannedMessage {
  patientId: string;
  /** The start of the appointment when the message was planned; null for a message without one. */
  plannedStartsAt: Date | null;
}

export interface CurrentAppointment {
  status: string;
  startsAt: Date;
  patientId: string;
}

/** The statuses in which the patient is already being attended, or the visit is over. */
const FINISHED_OR_UNDER_WAY: ReadonlySet<string> = new Set([
  'checked_in',
  'in_progress',
  'attended',
  'no_show',
]);

export function cancelReasonForAppointment(input: {
  now: Date;
  message: PlannedMessage;
  appointment: CurrentAppointment | null;
  /** False for a message that does not belong to an appointment (nothing to check). */
  appointmentBound?: boolean;
}): MessageCancelReason | null {
  if (input.appointmentBound === false) return null;
  const { appointment, message, now } = input;
  if (appointment === null || appointment.status === 'cancelled') return 'appointment_cancelled';
  if (FINISHED_OR_UNDER_WAY.has(appointment.status)) return 'appointment_over';
  if (now.getTime() >= appointment.startsAt.getTime()) return 'appointment_over';
  if (appointment.status === 'pending_approval') return 'appointment_changed';
  const moved =
    message.plannedStartsAt !== null &&
    message.plannedStartsAt.getTime() !== appointment.startsAt.getTime();
  if (moved || appointment.patientId !== message.patientId) return 'appointment_changed';
  return null;
}

/**
 * Whether a patient may still cancel by the link in a reminder: until `deadlineHours` before the
 * start (the organization's deadline for changes by link), never at or after the start. Past the
 * deadline the patient is asked to contact the organization.
 */
export function withinCancelDeadline(input: {
  now: Date;
  startsAt: Date;
  deadlineHours: number;
}): boolean {
  const limit = input.startsAt.getTime() - input.deadlineHours * 3_600_000;
  return input.now.getTime() <= limit && input.now.getTime() < input.startsAt.getTime();
}

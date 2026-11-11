import type { AppointmentStatus } from '@consultorio/contracts';

/**
 * What a patient may do to an upcoming appointment from the portal (patient-portal "Appointments
 * in the portal"). The organization's cancellation cut-off is the hours before the start until
 * which a patient may change their mind; after it they contact the organization. These rules run
 * on the server for every action: the screen only reflects them.
 */
export interface AppointmentState {
  status: AppointmentStatus;
  startsAt: Date;
  now: Date;
  /** The cut-off of the organization, in hours before the start. */
  deadlineHours: number;
}

const HOUR_MS = 3_600_000;

/** The last moment a patient may cancel. */
export function cancelDeadline(startsAt: Date, deadlineHours: number): Date {
  return new Date(startsAt.getTime() - deadlineHours * HOUR_MS);
}

/** Confirming is for an appointment that was booked and is still to come. */
export function canConfirm(state: AppointmentState): boolean {
  return state.status === 'scheduled' && state.startsAt.getTime() > state.now.getTime();
}

/** Cancelling is for an appointment to come, before the cut-off of the organization. */
export function canCancel(state: AppointmentState): boolean {
  const open: readonly AppointmentStatus[] = ['pending_approval', 'scheduled', 'confirmed'];
  return (
    open.includes(state.status) &&
    state.startsAt.getTime() > state.now.getTime() &&
    state.now.getTime() < cancelDeadline(state.startsAt, state.deadlineHours).getTime()
  );
}

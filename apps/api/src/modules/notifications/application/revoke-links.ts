import type { Tx } from '../../../platform/db/tenant-context.js';
import type { AppointmentEvent } from '../../../platform/events/appointment-events.js';
import type { ActionTokens, TokenKind } from '../../../platform/tokens/index.js';

/** The links that belong to one appointment: they die with the time they were issued for. */
const APPOINTMENT_LINKS: readonly TokenKind[] = [
  'appointment_confirm',
  'appointment_cancel',
  'appointment_reschedule',
];

/** The statuses after which a link to the appointment has nothing left to do. */
const FINISHED: ReadonlySet<string> = new Set(['checked_in', 'in_progress', 'attended', 'no_show']);

/**
 * Keeps the links of an appointment honest (spec "Confirmation by the patient"; design 4.5:
 * "Reschedule and reassignment revoke the appointment tokens of the previous appointment version").
 * A link in an old email must not confirm, cancel or move an appointment that is no longer the one
 * it was written for. It runs in the transaction of the change, like the planner.
 *
 * One exception: the booking manage link (`appointment_reschedule`) survives a cancellation. It can
 * do nothing on a cancelled appointment, and its page tells the patient the appointment was
 * cancelled instead of the same blank "link not available" page of a link that never existed.
 */
export function createLinkRevoker(tokens: ActionTokens) {
  return {
    async handle(tx: Tx, event: AppointmentEvent): Promise<void> {
      const ends =
        event.kind === 'rescheduled' ||
        event.kind === 'reassigned' ||
        event.kind === 'patient_changed' ||
        event.kind === 'cancelled' ||
        (event.kind === 'status_changed' && FINISHED.has(event.appointment.status));
      if (!ends) return;
      for (const kind of APPOINTMENT_LINKS) {
        if (event.kind === 'cancelled' && kind === 'appointment_reschedule') continue;
        await tokens.revokeForSubject(tx, kind, event.appointment.appointmentId);
      }
    },
  };
}

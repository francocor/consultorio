import type { AppointmentStatus, Permission } from '@consultorio/contracts';

export interface ConsultationContext {
  status: AppointmentStatus;
  identityConfirmed: boolean;
  /** The signed-in person is the professional this appointment is with. */
  isOwnProfessional: boolean;
  permissions: readonly Permission[];
  readOnly: boolean;
}

/**
 * How the appointment leads into the clinical record (decision D20). Only the professional of the
 * appointment can open an encounter from it, only with a confirmed identity (D14, D18), never in a
 * read-only organization, and only while the visit is happening:
 *
 * - `start`: the patient is in the waiting room. Calling them in moves the appointment to "in
 *   progress" and takes the professional to the new encounter;
 * - `open`: the visit is in progress; a link to the new encounter.
 *
 * The API and the database check all of it again, so hiding the step is a courtesy.
 */
export function consultationStep(context: ConsultationContext): 'start' | 'open' | null {
  const granted = new Set(context.permissions);
  if (
    !context.isOwnProfessional ||
    !context.identityConfirmed ||
    context.readOnly ||
    !granted.has('clinical.note.write')
  ) {
    return null;
  }
  if (context.status === 'in_progress') return 'open';
  if (context.status === 'checked_in' && granted.has('scheduling.checkin')) return 'start';
  return null;
}

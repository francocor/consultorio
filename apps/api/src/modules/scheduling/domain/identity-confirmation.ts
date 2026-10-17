/**
 * Who has checked who the patient is (decisions D14 and D18). An appointment whose identity is not
 * confirmed keeps its professional out of the patient's clinical record (the care relationship
 * ignores it), so confirming is a security step, not a formality.
 */

export type AppointmentSource = 'staff' | 'online' | 'waitlist_offer';

/** How an identity was confirmed: by staff other than the professional, or (D18) by the sole professional. */
export type IdentityConfirmation = 'staff' | 'self_confirmed';

/**
 * Whether a new appointment starts with its identity confirmed (design 3.6, D14).
 *
 * It starts UNCONFIRMED when it attaches to an EXISTING patient without anyone checking who that
 * is: (a) a public booking (or a waitlist offer accepted from one) matched by document, or (b) the
 * booking actor is the appointment's own professional. A booking that creates the patient is not a
 * match, and every other staff booking is a person looking at the record: both start confirmed.
 */
export function initialIdentityConfirmed(input: {
  source: AppointmentSource;
  patient: 'existing' | 'created';
  bookingActorProfessionalId: string | null;
  appointmentProfessionalId: string;
}): boolean {
  if (input.patient === 'created') return true;
  if (input.source !== 'staff') return false;
  return input.bookingActorProfessionalId !== input.appointmentProfessionalId;
}

/**
 * Who may confirm an identity, and how it is recorded; null means nobody in this position may.
 *
 * - A staff member who is not the appointment's professional (reception, admin, another
 *   professional) confirms at the worklist item or at check-in: `staff`.
 * - The appointment's own professional never confirms from the worklist. At in-person check-in they
 *   may, but only in a solo practice, and it is recorded as `self_confirmed` (D18).
 */
export function canConfirmIdentity(input: {
  actorProfessionalId: string | null;
  appointmentProfessionalId: string;
  channel: 'worklist' | 'check_in';
  soloPractice: boolean;
}): IdentityConfirmation | null {
  if (input.actorProfessionalId !== input.appointmentProfessionalId) return 'staff';
  return input.channel === 'check_in' && input.soloPractice ? 'self_confirmed' : null;
}

/**
 * The solo condition of D18, evaluated when the confirmation happens: exactly one active
 * professional and no other active member (no reception, no other admin) who could confirm.
 */
export function isSoloPractice(input: {
  activeProfessionals: number;
  otherActiveMembers: number;
}): boolean {
  return input.activeProfessionals === 1 && input.otherActiveMembers === 0;
}

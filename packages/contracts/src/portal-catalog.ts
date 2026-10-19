/**
 * The error codes and audit actions of the portal module (patient identities, sign-in by code,
 * read models, downloads), apart from its schemas (see `billing-catalog.ts` for why they live
 * apart).
 */

/**
 * Error codes of the portal module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.portal.json`, keyed by the
 * code. The portal track (Track B) adds its codes here and nowhere else.
 */
export const PORTAL_ERRORS = {
  // The patient has no email on record, so there is nowhere to send the invitation.
  portal_patient_has_no_email: { status: 409, i18nKey: 'errors.portal_patient_has_no_email' },
  // The email already belongs to the portal account of another person: ask for a different one.
  portal_email_in_use: { status: 409, i18nKey: 'errors.portal_email_in_use' },
  // The patient already has a portal account of their own.
  portal_already_linked: { status: 409, i18nKey: 'errors.portal_already_linked' },
  // The account or the link is already deactivated, or the patient cannot be invited.
  portal_state_conflict: { status: 409, i18nKey: 'errors.portal_state_conflict' },
  // The visitor did not solve the bot challenge (missing, wrong, expired or used twice).
  portal_challenge_failed: { status: 400, i18nKey: 'errors.portal_challenge_failed' },
  // The code is wrong, expired, spent, or there never was one. One answer for all of them.
  portal_code_invalid: { status: 400, i18nKey: 'errors.portal_code_invalid' },
  // The person has several records to read and has not picked one yet (or the one they picked ended).
  portal_subject_required: { status: 409, i18nKey: 'errors.portal_subject_required' },
  // The appointment is inside the cancellation cut-off: the patient contacts the organization.
  portal_cancel_deadline_passed: { status: 409, i18nKey: 'errors.portal_cancel_deadline_passed' },
  // The appointment is not in a state where the action applies (already cancelled, already over).
  portal_appointment_unavailable: { status: 409, i18nKey: 'errors.portal_appointment_unavailable' },
  // A representative is for a minor. An adult is represented only through their own authorization,
  // given from their own portal account; the organization cannot create or restore that link.
  portal_representation_requires_minor: {
    status: 409,
    i18nKey: 'errors.portal_representation_requires_minor',
  },
  // A minor reaches the portal only through a verified representative, never as their own account.
  portal_minor_requires_representative: {
    status: 409,
    i18nKey: 'errors.portal_minor_requires_representative',
  },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/**
 * Audit actions of the portal. They are registered in the shared catalogue. A portal entry names
 * the identity and the link, never a code, a token or the content of what was read.
 */
export const PORTAL_AUDIT_ACTIONS = [
  'portal.identity.created',
  'portal.identity.linked',
  'portal.identity.deactivated',
  'portal.signin.success',
  'portal.signin.failure',
  'portal.read',
  'portal.download',
  'portal.profile.changed',
  'portal.denied',
  // A notice sent by email about a change to the access (a representative was given access to a
  // record, the address of an account was changed). The entry names the kind, never the address.
  'portal.notice.sent',
] as const;

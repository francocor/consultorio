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
] as const;

/**
 * The error codes and audit actions of the consent module (templates, requests, signatures,
 * revocations), apart from its schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the consent module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.consent.json`, keyed by the
 * code. The consent track (Track A2) adds its codes here and nowhere else.
 */
export const CONSENT_ERRORS = {
  // The template is retired: it takes no changes and is not offered for new signatures.
  consent_template_retired: { status: 409, i18nKey: 'errors.consent_template_retired' },
  // Only a draft is published for the first time; a published template is changed by editing it.
  consent_template_not_draft: { status: 409, i18nKey: 'errors.consent_template_not_draft' },
  // The appointment type named by the template does not exist in the organization.
  consent_appointment_type_unknown: {
    status: 422,
    i18nKey: 'errors.consent_appointment_type_unknown',
  },
  // The starter named by the request is not one the product ships.
  consent_starter_unknown: { status: 422, i18nKey: 'errors.consent_starter_unknown' },
  // The template is a draft or retired, or has no published version: it cannot be requested.
  consent_template_not_offered: { status: 409, i18nKey: 'errors.consent_template_not_offered' },
  // The patient already has a request for this consent waiting to be signed.
  consent_request_pending: { status: 409, i18nKey: 'errors.consent_request_pending' },
  // The request passed its expiry date: it cannot be signed.
  consent_request_expired: { status: 409, i18nKey: 'errors.consent_request_expired' },
  // The request is not waiting for a signature (it was signed, declined, expired or revoked).
  consent_request_closed: { status: 409, i18nKey: 'errors.consent_request_closed' },
  // A request is signed the way it was made: on the device at reception, or in the portal.
  consent_method_mismatch: { status: 409, i18nKey: 'errors.consent_method_mismatch' },
  // The signature was submitted without the explicit acceptance action.
  consent_acceptance_required: { status: 422, i18nKey: 'errors.consent_acceptance_required' },
  // The signer was shown another version than the one the request is bound to.
  consent_version_mismatch: { status: 409, i18nKey: 'errors.consent_version_mismatch' },
  // A minor signs through a representative, whose data is needed.
  consent_representative_required: {
    status: 422,
    i18nKey: 'errors.consent_representative_required',
  },
  // Representative data came with a signature that is the patient's own.
  consent_representative_unexpected: {
    status: 422,
    i18nKey: 'errors.consent_representative_unexpected',
  },
  // The drawn signature is not a usable PNG image.
  consent_mark_invalid: { status: 422, i18nKey: 'errors.consent_mark_invalid' },
  // Only a signed consent is revoked.
  consent_not_signed: { status: 409, i18nKey: 'errors.consent_not_signed' },
  // The consent was already revoked: a revocation is recorded once.
  consent_already_revoked: { status: 409, i18nKey: 'errors.consent_already_revoked' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/**
 * Audit actions of consent. They are registered in the shared catalogue. The metadata of an entry
 * names the template, the version and the request, never the text that was signed and never the
 * evidence of the signature.
 */
export const CONSENT_AUDIT_ACTIONS = [
  'consent.template.created',
  'consent.template.published',
  'consent.template.retired',
  'consent.requested',
  'consent.signed',
  'consent.revoked',
  'consent.read',
  'consent.expired',
] as const;

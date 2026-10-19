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

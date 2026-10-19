/**
 * The error codes and audit actions of the consent module (templates, requests, signatures,
 * revocations), apart from its schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the consent module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.consent.json`, keyed by the
 * code. The consent track (Track A2) adds its codes here and nowhere else.
 */
export const CONSENT_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

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

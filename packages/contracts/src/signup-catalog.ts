/**
 * The error codes and audit actions of the signup (self-service creation of an organization), apart
 * from its schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the signup, with their status and the key of the es-AR message. They join the API
 * catalog (errors.ts); the messages go in `locales/es-AR/errors.signup.json`, keyed by the code. The
 * signup track (Track B) adds its codes here and nowhere else. A code must never tell a visitor
 * whether a name or an address is already in use.
 */
export const SIGNUP_ERRORS = {
  // The visitor did not accept both documents. Says nothing about names or addresses.
  signup_terms_required: { status: 400, i18nKey: 'errors.signup_terms_required' },
  // The bot challenge was missing, wrong, expired or used twice.
  signup_challenge_failed: { status: 400, i18nKey: 'errors.signup_challenge_failed' },
  // The emailed link does not exist, expired, was used or was replaced by a newer one: one answer for
  // all of them, and the page offers a new link.
  signup_link_invalid: { status: 400, i18nKey: 'errors.signup_link_invalid' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/**
 * Audit actions of a signup that has an organization to write to (unverified or active). The entry
 * of a terms acceptance names the versions, never the text.
 */
export const SIGNUP_AUDIT_ACTIONS = [
  'signup.created',
  'signup.verified',
  'terms.accepted',
] as const;

/**
 * The purge of an unverified signup hard-deletes the organization and its trail, so it is written
 * in the platform trail (the second retention exception of the design, `signup.purge`).
 */
export const SIGNUP_PLATFORM_AUDIT_ACTIONS = ['signup.purged'] as const;

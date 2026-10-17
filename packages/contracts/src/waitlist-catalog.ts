/**
 * The error codes and audit actions of the waitlist. They live apart from the schemas so the catalogs
 * (errors.ts, audit-actions.ts), which the sign-in bundle imports, do not pull in the module's
 * request schemas.
 */

/**
 * Error codes of the waitlist module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.waitlist.json`, keyed by the
 * code.
 */
export const WAITLIST_ERRORS = {
  // The patient already holds the most active entries the organization allows.
  waitlist_entry_limit: { status: 409, i18nKey: 'errors.waitlist_entry_limit' },
  // The entry is closed or expired: nothing can be changed on it.
  waitlist_entry_closed: { status: 409, i18nKey: 'errors.waitlist_entry_closed' },
  // The patient is inactive, or the type, professional or place cannot be waited for.
  waitlist_not_available: { status: 409, i18nKey: 'errors.waitlist_not_available' },
  // The joining visitor did not tick the agreement to receive offers.
  waitlist_opt_in_required: { status: 400, i18nKey: 'errors.waitlist_opt_in_required' },
  // The one-time code of a join is wrong, expired or spent. One answer for all of them.
  waitlist_code_invalid: { status: 400, i18nKey: 'errors.waitlist_code_invalid' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of the waitlist. They are registered in the shared catalogue. */
export const WAITLIST_AUDIT_ACTIONS = [
  'waitlist.entry.created',
  'waitlist.entry.updated',
  'waitlist.entry.closed',
  'waitlist.offer.created',
  'waitlist.offer.accepted',
  'waitlist.offer.declined',
  'waitlist.offer.expired',
  'waitlist.priority.overridden',
] as const;

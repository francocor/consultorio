/**
 * The error codes and audit actions of the online-booking module, apart from its schemas. The shared
 * error catalog (errors.ts) and audit catalogue (audit-actions.ts) import this file, so the web
 * bundle that needs only the codes does not drag every schema of the module along. The module's
 * contracts file re-exports both.
 */

/**
 * Error codes of the online-booking module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.online-booking.json`, keyed by the
 * code. The track adds its codes here.
 */
export const ONLINE_BOOKING_ERRORS = {
  // The visitor did not solve the bot challenge (missing, wrong, expired or used twice).
  booking_challenge_failed: { status: 400, i18nKey: 'errors.booking_challenge_failed' },
  // The one-time code is wrong, expired or spent. One answer for all of them.
  booking_code_invalid: { status: 400, i18nKey: 'errors.booking_code_invalid' },
  // The contact already holds the most future online appointments, or the day's bookings are used.
  booking_limit_reached: { status: 409, i18nKey: 'errors.booking_limit_reached' },
  // The link to change or cancel an appointment came after the organization's deadline.
  booking_change_deadline_passed: {
    status: 409,
    i18nKey: 'errors.booking_change_deadline_passed',
  },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of online booking. They are registered in the shared catalogue. */
export const ONLINE_BOOKING_AUDIT_ACTIONS = [
  'booking.link.enabled',
  'booking.link.disabled',
  'booking.link.regenerated',
  'booking.online.created',
  'booking.suspicious',
] as const;

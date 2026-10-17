/**
 * The error codes and audit actions of the notifications module, apart from its schemas. The shared
 * error catalog (errors.ts) and audit catalogue (audit-actions.ts) import this file, so the web
 * bundle that needs only the codes does not drag every schema of the module along. The module's
 * contracts file re-exports both.
 */

/**
 * Error codes of the notifications module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.notifications.json`, keyed by the
 * code. The track adds its codes here.
 */
export const NOTIFICATION_ERRORS = {
  /** Only the patient can switch back on a channel the patient switched off. */
  channel_opted_out: { status: 409, i18nKey: 'errors.channel_opted_out' },
  patient_without_email: { status: 422, i18nKey: 'errors.patient_without_email' },
  patient_without_phone: { status: 422, i18nKey: 'errors.patient_without_phone' },
  /** Three manual resends per appointment. */
  resend_limit_reached: { status: 409, i18nKey: 'errors.resend_limit_reached' },
  /** The appointment is over, or the channel cannot be used for this patient. */
  resend_unavailable: { status: 409, i18nKey: 'errors.resend_unavailable' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of messaging. They are registered in the shared catalogue (`audit-actions.ts`). */
export const NOTIFICATION_AUDIT_ACTIONS = [
  'notification.optout.recorded',
  'notification.optin.recorded',
  'notification.resend',
  'notification.integration.changed',
] as const;

/**
 * The error codes and audit actions of the teleconsultation module, apart from its schemas. The shared
 * error catalog (errors.ts) and audit catalogue (audit-actions.ts) import this file, so the web
 * bundle that needs only the codes does not drag every schema of the module along. The module's
 * contracts file re-exports both.
 */

/**
 * Error codes of the teleconsultation module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.teleconsultation.json`, keyed by the
 * code.
 */
export const TELECONSULTATION_ERRORS = {
  // The professional asked to join outside the join window.
  video_outside_window: { status: 409, i18nKey: 'errors.video_outside_window' },
  // The appointment has no usable link (pending, closed or revoked).
  video_link_unavailable: { status: 409, i18nKey: 'errors.video_link_unavailable' },
  // The appointment is not a virtual one.
  video_not_virtual: { status: 409, i18nKey: 'errors.video_not_virtual' },
  // A no-show on a virtual appointment waits for the configured minutes after the start.
  video_no_show_too_early: { status: 409, i18nKey: 'errors.video_no_show_too_early' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of video links. They are registered in the shared catalogue. */
export const TELECONSULTATION_AUDIT_ACTIONS = [
  'video.link.created',
  'video.link.opened',
  'video.link.revoked',
  'video.link.joined',
  'video.link.manual_attached',
] as const;

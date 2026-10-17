const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Every kind of single-purpose link the product sends (design 4.5, canonical list). */
export const TOKEN_KINDS = [
  'appointment_confirm',
  'appointment_cancel',
  'appointment_reschedule',
  'waitlist_offer',
  'video_join',
  'notification_opt_out',
  'whatsapp_opt_in',
  'staff_invitation',
  'password_reset',
  'signup_verification',
  'portal_activation',
  'document_download',
  'archive_release',
] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

export interface KindSpec {
  /** Longest lifetime an issuer may ask for. */
  ttlMs: number;
  /** Most times a token of this kind can be redeemed. */
  maxUses: number;
  /** The token only works for the session it was issued to (downloads). */
  sessionBound: boolean;
  /** False until the capability that sends the link exists: issuing it is refused. */
  enabled: boolean;
}

/**
 * Rules per kind. The expiry of the appointment kinds follows the appointment or the
 * organization's deadline, so their `ttlMs` is only the upper bound an issuer may not exceed.
 * Only the account flows are enabled in Stage 1; each later capability turns on its own kinds.
 */
export const TOKEN_KIND_REGISTRY: Record<TokenKind, KindSpec> = {
  staff_invitation: { ttlMs: 7 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  password_reset: { ttlMs: 30 * MINUTE, maxUses: 1, sessionBound: false, enabled: true },
  signup_verification: { ttlMs: 24 * HOUR, maxUses: 1, sessionBound: false, enabled: true },
  portal_activation: { ttlMs: 7 * DAY, maxUses: 1, sessionBound: false, enabled: true },

  appointment_confirm: { ttlMs: 60 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  appointment_cancel: { ttlMs: 60 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  appointment_reschedule: { ttlMs: 60 * DAY, maxUses: 1, sessionBound: false, enabled: false },
  waitlist_offer: { ttlMs: 2 * DAY, maxUses: 1, sessionBound: false, enabled: false },
  video_join: { ttlMs: 3 * HOUR, maxUses: 20, sessionBound: false, enabled: false },
  notification_opt_out: { ttlMs: 3650 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  whatsapp_opt_in: { ttlMs: 7 * DAY, maxUses: 1, sessionBound: false, enabled: false },
  document_download: { ttlMs: 5 * MINUTE, maxUses: 1, sessionBound: true, enabled: true },
  archive_release: { ttlMs: 72 * HOUR, maxUses: 1, sessionBound: false, enabled: false },
};

export function isTokenKind(value: string): value is TokenKind {
  return TOKEN_KINDS.some((kind) => kind === value);
}

export function isEnabledKind(kind: TokenKind): boolean {
  return TOKEN_KIND_REGISTRY[kind].enabled;
}

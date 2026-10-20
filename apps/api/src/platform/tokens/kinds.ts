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
  'export_download',
  'invoice_pdf',
  'prescription_pdf',
  'cancellation_export',
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
  // A booking can be made up to a year ahead (the horizon setting), and its link lives until the start.
  appointment_reschedule: { ttlMs: 366 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  waitlist_offer: { ttlMs: 2 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  // A reminder issues the link when it is sent, up to 14 days ahead (the longest lead time an
  // organization can set), so the kind allows 15 days; the issuer asks for the join window it
  // needs (until the window closes plus the hours the address stays known).
  video_join: { ttlMs: 15 * DAY, maxUses: 20, sessionBound: false, enabled: true },
  notification_opt_out: { ttlMs: 3650 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  whatsapp_opt_in: { ttlMs: 7 * DAY, maxUses: 1, sessionBound: false, enabled: true },
  document_download: { ttlMs: 5 * MINUTE, maxUses: 1, sessionBound: true, enabled: true },
  // The files of Stage 4 open through the same door as a document (`/files/:token`): the billing
  // track turns on the export link, the invoicing track the invoice PDF link.
  export_download: { ttlMs: 5 * MINUTE, maxUses: 1, sessionBound: true, enabled: true },
  invoice_pdf: { ttlMs: 5 * MINUTE, maxUses: 1, sessionBound: true, enabled: true },
  // Stage 5: the PDF of a prescription, for the staff who may read it. Its own kind, not a document
  // link: it opens a clinical file the documents module does not own (e-prescription track).
  prescription_pdf: { ttlMs: 5 * MINUTE, maxUses: 1, sessionBound: true, enabled: true },
  // Stage 6: a package of the cancellation export (the administrative one for the owner, a clinical
  // one for its professional). Its own kind, not `export_download`: the billing exports own that one
  // in the staff door, which holds one resource per kind.
  cancellation_export: { ttlMs: 5 * MINUTE, maxUses: 1, sessionBound: true, enabled: true },
  archive_release: { ttlMs: 72 * HOUR, maxUses: 1, sessionBound: false, enabled: false },
};

export function isTokenKind(value: string): value is TokenKind {
  return TOKEN_KINDS.some((kind) => kind === value);
}

export function isEnabledKind(kind: TokenKind): boolean {
  return TOKEN_KIND_REGISTRY[kind].enabled;
}

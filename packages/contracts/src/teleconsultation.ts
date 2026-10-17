import { z } from 'zod';

/**
 * Contracts of the teleconsultation module (platform join links for virtual appointments). This
 * file holds what is certain from the design and the spec; the teleconsultation track (S3.14,
 * S3.15) adds its request and response shapes below, in this file only.
 */

export const VIDEO_SESSION_STATUSES = ['ready', 'link_pending', 'closed'] as const;
export type VideoSessionStatus = (typeof VIDEO_SESSION_STATUSES)[number];

/**
 * Error codes of the teleconsultation module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.teleconsultation.json`, keyed by the
 * code. The track adds its codes here.
 */
export const TELECONSULTATION_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

/** Audit actions of video links. They are registered in the shared catalogue. */
export const TELECONSULTATION_AUDIT_ACTIONS = [
  'video.link.created',
  'video.link.opened',
  'video.link.revoked',
  'video.link.joined',
  'video.link.manual_attached',
] as const;

/** The `teleconsultation` section of the organization settings (spec defaults). */
export const TeleconsultationSettings = z.strictObject({
  /** The join window opens this many minutes before the start. */
  joinOpensMinutes: z.int().min(0).max(120),
  /** A no-show may be marked once the patient has not joined for this many minutes. */
  noShowAfterMinutes: z.int().min(1).max(120),
});
export type TeleconsultationSettings = z.infer<typeof TeleconsultationSettings>;

export const DEFAULT_TELECONSULTATION_SETTINGS: TeleconsultationSettings = {
  joinOpensMinutes: 15,
  noShowAfterMinutes: 15,
};

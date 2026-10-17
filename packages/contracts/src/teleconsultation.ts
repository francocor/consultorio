import { z } from 'zod';

export {
  TELECONSULTATION_ERRORS,
  TELECONSULTATION_AUDIT_ACTIONS,
} from './teleconsultation-catalog.js';

/**
 * Contracts of the teleconsultation module (platform join links for virtual appointments). This
 * file holds what is certain from the design and the spec; the teleconsultation track (S3.14,
 * S3.15) adds its request and response shapes below, in this file only.
 */

export const VIDEO_SESSION_STATUSES = ['ready', 'link_pending', 'closed'] as const;
export type VideoSessionStatus = (typeof VIDEO_SESSION_STATUSES)[number];

/** Why a session has no link yet. `creating` is the short wait for the job that asks the provider. */
export const VIDEO_PENDING_REASONS = [
  'creating',
  'integration_off',
  'provider_unavailable',
  'provider_failed',
] as const;
export type VideoPendingReason = (typeof VIDEO_PENDING_REASONS)[number];

/** Why a session closed for good. A reschedule does not close it: it gets a new room. */
export const VIDEO_CLOSE_REASONS = ['cancelled', 'no_show', 'attended', 'in_person'] as const;
export type VideoCloseReason = (typeof VIDEO_CLOSE_REASONS)[number];

/** The join window ends this many minutes after the scheduled end (it opens per the settings). */
export const VIDEO_JOIN_CLOSES_AFTER_END_MINUTES = 60;

const Instant = z.iso.datetime({ offset: true });

/** The longest address a manual link may have. */
export const MANUAL_VIDEO_LINK_MAX_LENGTH = 2048;

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

/** Attaches an address of a video call the professional or reception created elsewhere. */
export const ManualVideoLinkRequest = z.strictObject({
  url: z.string().min(1).max(MANUAL_VIDEO_LINK_MAX_LENGTH),
});
export type ManualVideoLinkRequest = z.infer<typeof ManualVideoLinkRequest>;

/**
 * What the screens know about the video side of an appointment. It never carries an address: a
 * link is reached through the join action (the assigned professional) or the platform join
 * address (the patient). Reception and administrators see only that it is virtual and whether a
 * link exists.
 */
export const VideoSessionSummary = z.strictObject({
  virtual: z.boolean(),
  status: z.enum(VIDEO_SESSION_STATUSES).nullable(),
  pendingReason: z.enum(VIDEO_PENDING_REASONS).nullable(),
  /** A link exists: the platform join address works inside the window. */
  hasLink: z.boolean(),
  /** The link is one a person attached, not one the provider created. */
  manual: z.boolean(),
  /** Administrative only: the patient opened the platform address inside the window. */
  patientOpenedLink: z.boolean(),
  firstOpenedAt: Instant.nullable(),
  /** The `integrations.video` switch of the organization. */
  integrationEnabled: z.boolean(),
  window: z.strictObject({ opensAt: Instant, closesAt: Instant }).nullable(),
  /** The viewer is the assigned professional, the window is open and the link is ready. */
  canJoin: z.boolean(),
  canAttachManualLink: z.boolean(),
  /** A no-show on this appointment is accepted from this instant on. */
  noShowAllowedFrom: Instant.nullable(),
});
export type VideoSessionSummary = z.infer<typeof VideoSessionSummary>;

/** The address the assigned professional is sent to when joining. */
export const VideoJoinResponse = z.strictObject({ url: z.url() });
export type VideoJoinResponse = z.infer<typeof VideoJoinResponse>;

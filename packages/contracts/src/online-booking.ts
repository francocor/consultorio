import { z } from 'zod';

/**
 * Contracts of the online-booking module (public booking links, holds, verified submissions). This
 * file holds what is certain from the design and the spec; the public-booking track (S3.07 to
 * S3.10) adds its request and response shapes below, in this file only.
 */

/**
 * Error codes of the online-booking module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.online-booking.json`, keyed by the
 * code. The track adds its codes here.
 */
export const ONLINE_BOOKING_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

/** Audit actions of online booking. They are registered in the shared catalogue. */
export const ONLINE_BOOKING_AUDIT_ACTIONS = [
  'booking.link.enabled',
  'booking.link.disabled',
  'booking.link.regenerated',
  'booking.online.created',
  'booking.suspicious',
] as const;

/** The `onlineBooking` section of the organization settings (spec defaults). */
export const OnlineBookingSettings = z.strictObject({
  /** The earliest bookable slot starts this many hours from now. */
  minLeadHours: z
    .int()
    .min(0)
    .max(24 * 14),
  /** The furthest bookable day, in days from today. */
  horizonDays: z.int().min(1).max(365),
  /** Most online bookings per professional and day; null means no cap. */
  dailyCap: z.int().min(1).max(500).nullable(),
  /** Until this many hours before the start a patient may change or cancel by link. */
  rescheduleDeadlineHours: z
    .int()
    .min(0)
    .max(24 * 14),
  /** An online booking waits for staff approval before it is scheduled. */
  requireApproval: z.boolean(),
});
export type OnlineBookingSettings = z.infer<typeof OnlineBookingSettings>;

export const DEFAULT_ONLINE_BOOKING_SETTINGS: OnlineBookingSettings = {
  minLeadHours: 2,
  horizonDays: 60,
  dailyCap: null,
  rescheduleDeadlineHours: 12,
  requireApproval: false,
};

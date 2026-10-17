import { z } from 'zod';

/**
 * Contracts of the notifications module (reminders, confirmations and offers over email and
 * WhatsApp). This file holds what is certain from the design and the spec; the notifications track
 * (S3.01 to S3.06) adds its request and response shapes below, in this file only.
 */

/** Email and WhatsApp. There is no SMS channel in v1. */
export const MESSAGE_CHANNELS = ['email', 'whatsapp'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** The life of a message, in the order it moves through them (design, section 5.2). */
export const MESSAGE_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'cancelled',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Audit actions of messaging. They are registered in the shared catalogue (`audit-actions.ts`). */
export const NOTIFICATION_AUDIT_ACTIONS = [
  'notification.optout.recorded',
  'notification.optin.recorded',
  'notification.resend',
  'notification.integration.changed',
] as const;

const MAX_REMINDERS = 3;
const MAX_LEAD_HOURS = 24 * 14;

/**
 * The `notifications` section of the organization settings. Quiet hours are the top-level
 * `quietHours` setting that exists since Stage 1, not repeated here. No lead time at all switches
 * reminders off without a deploy.
 */
export const NotificationSettings = z.strictObject({
  /** Up to three different lead times, in hours before the start. */
  reminderLeadHours: z
    .array(z.int().min(1).max(MAX_LEAD_HOURS))
    .max(MAX_REMINDERS)
    .refine((hours) => new Set(hours).size === hours.length, 'lead times must be different'),
  /** Neutral wording: messages do not name the professional. */
  hideProfessional: z.boolean(),
  /** Neutral wording: messages do not name the appointment type. */
  hideAppointmentType: z.boolean(),
});
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  reminderLeadHours: [24],
  hideProfessional: false,
  hideAppointmentType: false,
};

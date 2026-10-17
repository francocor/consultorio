import { z } from 'zod';

/**
 * Contracts of the notifications module (reminders, confirmations and offers over email and
 * WhatsApp). This file holds what is certain from the design and the spec; the notifications track
 * (S3.01 to S3.06) adds its request and response shapes below, in this file only.
 */

/** Email and WhatsApp. There is no SMS channel in v1. */
export const MESSAGE_CHANNELS = ['email', 'whatsapp'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/**
 * What a message is about. Reminders, confirmations and waitlist offers are tied to an appointment
 * or a waitlist entry and are the only ones that may use WhatsApp (with a recorded opt-in).
 */
export const APPOINTMENT_MESSAGE_KINDS = ['reminder', 'confirmation', 'waitlist_offer'] as const;
export type AppointmentMessageKind = (typeof APPOINTMENT_MESSAGE_KINDS)[number];

/** Everything else is sent by email only: codes, account flows, notices, invoices. */
export const EMAIL_ONLY_MESSAGE_KINDS = [
  'otp_code',
  'invitation',
  'password_reset',
  'portal_notice',
  'consent_request',
  'invoice',
  'subscription_notice',
] as const;
export type EmailOnlyMessageKind = (typeof EMAIL_ONLY_MESSAGE_KINDS)[number];

export const MESSAGE_KINDS = [...APPOINTMENT_MESSAGE_KINDS, ...EMAIL_ONLY_MESSAGE_KINDS] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Why a message ended `cancelled`. A cancelled message always carries one of these. */
export const MESSAGE_CANCEL_REASONS = [
  'tenant_read_only',
  'demo_tenant',
  'opted_out',
  /** The appointment moved: the reminder of the earlier time is replaced. */
  'appointment_changed',
  'appointment_cancelled',
  /** The appointment was attended, missed or has already started. */
  'appointment_over',
  'integration_off',
  'no_channel',
] as const;
export type MessageCancelReason = (typeof MESSAGE_CANCEL_REASONS)[number];

/** Why a message ended `failed`. Only codes: no provider text, no address. */
export const MESSAGE_FAILURE_REASONS = [
  'not_on_whatsapp',
  'template_rejected',
  'invalid_number',
  'mailbox_unavailable',
  'retries_exhausted',
] as const;
export type MessageFailureReason = (typeof MESSAGE_FAILURE_REASONS)[number];

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

/**
 * Error codes of the notifications module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.notifications.json`, keyed by the
 * code. The track adds its codes here.
 */
export const NOTIFICATION_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

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

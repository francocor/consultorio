import { z } from 'zod';

export { NOTIFICATION_ERRORS, NOTIFICATION_AUDIT_ACTIONS } from './notifications-catalog.js';

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
  /** The professional's WhatsApp quota is spent and the plan has no overage. */
  'quota_exhausted',
  'no_channel',
  /** A waitlist offer that was no longer open when its turn to be sent came. */
  'offer_expired',
] as const;
export type MessageCancelReason = (typeof MESSAGE_CANCEL_REASONS)[number];

/** Why a message ended `failed`. Only codes: no provider text, no address. */
export const MESSAGE_FAILURE_REASONS = [
  'not_on_whatsapp',
  'template_rejected',
  'invalid_number',
  'mailbox_unavailable',
  /** The provider took the message and later reported it undelivered (not a bad address). */
  'delivery_failed',
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

// The WhatsApp simulator console (`/operator/dev/whatsapp/*`, developer tool) ------------------

export const WHATSAPP_SIMULATOR_MODES = ['ok', 'down', 'reject_template'] as const;
export type WhatsAppSimulatorMode = (typeof WHATSAPP_SIMULATOR_MODES)[number];

/** One entry of the simulator's phone: a message it was given, or a reply typed into it. */
export const SimulatorMessageDto = z.strictObject({
  id: z.uuid(),
  providerMessageId: z.string(),
  direction: z.enum(['outbound', 'inbound']),
  /** The recipient of an outbound message, the sender of a reply (E.164). */
  number: z.string(),
  templateKey: z.string().nullable(),
  /** The text as the patient reads it. */
  body: z.string(),
  status: z.string(),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type SimulatorMessageDto = z.infer<typeof SimulatorMessageDto>;

export const SimulatorStateResponse = z.strictObject({
  messages: z.array(SimulatorMessageDto),
  mode: z.enum(WHATSAPP_SIMULATOR_MODES),
  unreachableNumbers: z.array(z.string()),
});
export type SimulatorStateResponse = z.infer<typeof SimulatorStateResponse>;

/** A delivery receipt typed into the simulator: it is signed and posted to the real webhook. */
export const SimulatorStatusRequest = z.strictObject({
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  errorCode: z.string().min(1).max(64).optional(),
});
export type SimulatorStatusRequest = z.infer<typeof SimulatorStatusRequest>;

/** A reply typed into the simulator by a patient. */
export const SimulatorInboundRequest = z.strictObject({
  from: z.string().min(5).max(20),
  text: z.string().max(1000),
});
export type SimulatorInboundRequest = z.infer<typeof SimulatorInboundRequest>;

export const SimulatorModeRequest = z.strictObject({ mode: z.enum(WHATSAPP_SIMULATOR_MODES) });
export type SimulatorModeRequest = z.infer<typeof SimulatorModeRequest>;

export const SimulatorUnreachableRequest = z.strictObject({
  number: z.string().min(5).max(20),
  unreachable: z.boolean(),
});
export type SimulatorUnreachableRequest = z.infer<typeof SimulatorUnreachableRequest>;

/** What the simulator did with a simulated event. */
export const SimulatorEventResponse = z.strictObject({
  /** True when the application's own webhook accepted the signed event. */
  delivered: z.boolean(),
});
export type SimulatorEventResponse = z.infer<typeof SimulatorEventResponse>;

// Channel choices of a patient (reception) -----------------------------------------------------

/** A channel as the patient left it: the choice in force and where and when it was recorded. */
export const ChannelStateDto = z.strictObject({
  /** `default`: email nobody switched off. `none`: WhatsApp nobody switched on. */
  state: z.enum(['default', 'none', 'opted_in', 'opted_out']),
  source: z.string().nullable(),
  recordedAt: z.iso.datetime().nullable(),
});
export type ChannelStateDto = z.infer<typeof ChannelStateDto>;

export const PatientChannelsResponse = z.strictObject({
  email: ChannelStateDto,
  whatsapp: ChannelStateDto,
  /** Whether the record has an email, and a phone that can be read as a mobile number. */
  hasEmail: z.boolean(),
  hasMobile: z.boolean(),
});
export type PatientChannelsResponse = z.infer<typeof PatientChannelsResponse>;

export const ChannelParams = z.strictObject({
  id: z.uuid(),
  channel: z.enum(MESSAGE_CHANNELS),
});
export type ChannelParams = z.infer<typeof ChannelParams>;

// WhatsApp usage per professional (administration) ---------------------------------------------

export const USAGE_STATES = ['unlimited', 'ok', 'warning', 'exhausted'] as const;
export type UsageState = (typeof USAGE_STATES)[number];

/** Share of the monthly quota at which the owner is warned, and at which the quota is spent. */
export const USAGE_WARNING_PERCENT = 80;

export const ProfessionalUsageDto = z.strictObject({
  professionalId: z.uuid(),
  /** Null when the member has no display name. */
  name: z.string().nullable(),
  /** WhatsApp messages the provider accepted this month. Counts only: no patient, no text. */
  count: z.int().nonnegative(),
  /** The monthly quota of the plan; null when there is none to apply. */
  limit: z.int().positive().nullable(),
  state: z.enum(USAGE_STATES),
});
export type ProfessionalUsageDto = z.infer<typeof ProfessionalUsageDto>;

export const UsageResponse = z.strictObject({
  /** `YYYY-MM` (UTC). */
  period: z.string().regex(/^\d{4}-\d{2}$/),
  professionals: z.array(ProfessionalUsageDto),
});
export type UsageResponse = z.infer<typeof UsageResponse>;

// The message log of an appointment ------------------------------------------------------------

export const MessageLogEntryDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(MESSAGE_KINDS),
  channel: z.enum(MESSAGE_CHANNELS),
  status: z.enum(MESSAGE_STATUSES),
  /** `manual` for a resend that a person asked for. */
  trigger: z.enum(['automatic', 'manual']),
  cancelReason: z.enum(MESSAGE_CANCEL_REASONS).nullable(),
  failureReason: z.enum(MESSAGE_FAILURE_REASONS).nullable(),
  sendAt: z.iso.datetime(),
  sentAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  readAt: z.iso.datetime().nullable(),
  attempts: z.int().nonnegative(),
});
export type MessageLogEntryDto = z.infer<typeof MessageLogEntryDto>;

/** Manual resends allowed per appointment (spec "Audit and access to notification data"). */
export const MAX_MANUAL_RESENDS = 3;

export const AppointmentMessagesResponse = z.strictObject({
  messages: z.array(MessageLogEntryDto),
  /** True when reception has an open "reminder not sent" item: no automated reminders go out. */
  noAutomatedReminders: z.boolean(),
  resendsLeft: z.int().min(0).max(MAX_MANUAL_RESENDS),
});
export type AppointmentMessagesResponse = z.infer<typeof AppointmentMessagesResponse>;

export const ResendMessageRequest = z.strictObject({ channel: z.enum(MESSAGE_CHANNELS) });
export type ResendMessageRequest = z.infer<typeof ResendMessageRequest>;

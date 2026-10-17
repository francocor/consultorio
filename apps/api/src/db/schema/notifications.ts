import {
  APPOINTMENT_MESSAGE_KINDS,
  MESSAGE_CANCEL_REASONS,
  MESSAGE_CHANNELS,
  MESSAGE_FAILURE_REASONS,
  MESSAGE_KINDS,
  MESSAGE_STATUSES,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { appointment } from './scheduling.js';
import { professional } from './staff.js';
import { location, tenant } from './tenant.js';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * How an attempt to hand a message to its provider ended. `started` is written (and committed)
 * BEFORE the provider is called and replaced by the real outcome afterwards: a worker that dies in
 * between leaves it behind, and the retry knows the provider may already have the message.
 */
export const ATTEMPT_OUTCOMES = ['started', 'accepted', 'retryable', 'rejected', 'error'] as const;

/** Who started a message: the planner (`automatic`) or a person pressing "resend" (`manual`). */
export const MESSAGE_TRIGGERS = ['automatic', 'manual'] as const;

/**
 * One message to one patient on one channel: a reminder, a confirmation, a waitlist offer or an
 * email-only notice. The row is the log that reception reads per appointment, so it holds METADATA
 * only (kind, channel, status, times, reason codes): never the text, never an address, never a
 * clinical fact. The address is kept as a hash, enough to know that "this number failed" without
 * keeping the number, and to match an inbound WhatsApp reply to the organization that wrote first.
 *
 * - `dedupe_key` is unique per organization: planning and retrying the same reminder twice yields
 *   one row, and one message on the wire.
 * - `status` follows the design (queued, sent, delivered, read, failed, cancelled). A cancelled
 *   message says why (`cancel_reason`), a failed one says why (`failure_reason`).
 * - `professional_id` attributes a WhatsApp message to a professional for the usage quota.
 * - A message is cancelled, never deleted.
 */
export const message = tenantTable(
  'message',
  {
    /** Null for a message that is not about an appointment (a waitlist offer, a notice). */
    appointmentId: uuid('appointment_id'),
    patientId: uuid('patient_id').notNull(),
    professionalId: uuid('professional_id'),
    kind: text('kind').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('queued'),
    cancelReason: text('cancel_reason'),
    failureReason: text('failure_reason'),
    providerMessageId: text('provider_message_id'),
    dedupeKey: text('dedupe_key').notNull(),
    /** SHA-256 of the address the message went to (lower-case email, E.164 number). */
    addressHash: text('address_hash'),
    /** The start of the appointment the message was planned for; a move makes the message stale. */
    plannedStartsAt: timestamp('planned_starts_at', { withTimezone: true }),
    /** The version of the appointment when the message was planned (informational). */
    appointmentVersion: integer('appointment_version'),
    /** When the message is due. */
    sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    attempts: smallint('attempts').notNull().default(0),
    trigger: text('trigger').notNull().default('automatic'),
    /**
     * True when this message went out saying that the video link of the appointment would follow
     * (the link did not exist yet). It is what the follow-up with the link is queued for.
     */
    videoPending: boolean('video_pending').notNull().default(false),
  },
  (table) => [
    foreignKey({
      name: 'message_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'message_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'message_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    foreignKey({
      name: 'message_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('message_kind_check', sql.raw(`"kind" in (${list(MESSAGE_KINDS)})`)),
    check('message_channel_check', sql.raw(`"channel" in (${list(MESSAGE_CHANNELS)})`)),
    check('message_status_check', sql.raw(`"status" in (${list(MESSAGE_STATUSES)})`)),
    // WhatsApp carries only the messages of an appointment or a waitlist entry (D5).
    check(
      'message_whatsapp_kind_check',
      sql.raw(`"channel" = 'email' or "kind" in (${list(APPOINTMENT_MESSAGE_KINDS)})`),
    ),
    check(
      'message_cancel_reason_check',
      sql.raw(
        `("status" = 'cancelled') = ("cancel_reason" is not null) and ("cancel_reason" is null or "cancel_reason" in (${list(MESSAGE_CANCEL_REASONS)}))`,
      ),
    ),
    check(
      'message_failure_reason_check',
      sql.raw(
        `("status" = 'failed') = ("failure_reason" is not null) and ("failure_reason" is null or "failure_reason" in (${list(MESSAGE_FAILURE_REASONS)}))`,
      ),
    ),
    check('message_trigger_check', sql.raw(`"trigger" in (${list(MESSAGE_TRIGGERS)})`)),
    check('message_attempts_check', sql`${table.attempts} >= 0`),
    unique('message_tenant_id_dedupe_key_key').on(table.tenantId, table.dedupeKey),
    // A provider id names one message of one organization (the webhook finds the tenant by it).
    uniqueIndex('message_provider_message_id_key')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} is not null`),
    index('message_appointment_idx').on(table.tenantId, table.appointmentId, table.createdAt),
    index('message_patient_idx').on(table.tenantId, table.patientId, table.channel),
    index('message_queue_idx')
      .on(table.tenantId, table.sendAt)
      .where(sql`${table.status} = 'queued'`),
    // "Has this address failed for good?" and "who wrote to this number?".
    index('message_address_idx')
      .on(table.tenantId, table.channel, table.addressHash)
      .where(sql`${table.addressHash} is not null`),
  ],
);

export type MessageRow = typeof message.$inferSelect;

/** One try at handing a message to its provider. The reason is a code, never provider text. */
export const messageAttempt = tenantTable(
  'message_attempt',
  {
    messageId: uuid('message_id').notNull(),
    attemptNo: smallint('attempt_no').notNull(),
    outcome: text('outcome').notNull(),
    reason: text('reason'),
  },
  (table) => [
    foreignKey({
      name: 'message_attempt_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'message_attempt_message_fkey',
      columns: [table.tenantId, table.messageId],
      foreignColumns: [message.tenantId, message.id],
    }),
    check('message_attempt_outcome_check', sql.raw(`"outcome" in (${list(ATTEMPT_OUTCOMES)})`)),
    check('message_attempt_no_check', sql`${table.attemptNo} >= 1`),
    unique('message_attempt_tenant_id_message_id_attempt_no_key').on(
      table.tenantId,
      table.messageId,
      table.attemptNo,
    ),
  ],
);

export type MessageAttemptRow = typeof messageAttempt.$inferSelect;

/**
 * What a waitlist offer message needs to be written and sent: the slot it offers and the link that
 * accepts it. An offer is not about an appointment, so the message has nothing else to read. The
 * link is the one thing a message log must not hold (the log is metadata only), so it lives here,
 * apart from the log: it is read by the sending job, and cleared by the hourly sweep once the offer
 * has expired (the link is worthless then). The row is created with the message and never deleted.
 */
export const messageOffer = tenantTable(
  'message_offer',
  {
    messageId: uuid('message_id').notNull(),
    /** The offer of the waitlist module this message carries (no foreign key: another module). */
    offerId: uuid('offer_id').notNull(),
    locationId: uuid('location_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** After this moment the message is not sent and the link is cleared. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** The single-use address that accepts the offer. Null once the offer expired. */
    url: text('url'),
  },
  (table) => [
    foreignKey({
      name: 'message_offer_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'message_offer_message_fkey',
      columns: [table.tenantId, table.messageId],
      foreignColumns: [message.tenantId, message.id],
    }),
    foreignKey({
      name: 'message_offer_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('message_offer_window_check', sql`${table.startsAt} < ${table.endsAt}`),
    unique('message_offer_tenant_id_message_id_key').on(table.tenantId, table.messageId),
    // The sweep looks for links still held after their offer expired.
    index('message_offer_url_idx')
      .on(table.tenantId, table.expiresAt)
      .where(sql`${table.url} is not null`),
  ],
);

export type MessageOfferRow = typeof messageOffer.$inferSelect;

/** What a provider event did to the message it is about. */
export const MESSAGE_EVENT_STATUSES = ['sent', 'delivered', 'read', 'failed'] as const;

/**
 * A status event of the WhatsApp provider that was applied, by the id the provider gave it. The
 * unique key is the idempotence of the webhook: a replayed event finds its row and changes nothing.
 */
export const messageEvent = tenantTable(
  'message_event',
  {
    eventId: text('event_id').notNull(),
    messageId: uuid('message_id').notNull(),
    status: text('status').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'message_event_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'message_event_message_fkey',
      columns: [table.tenantId, table.messageId],
      foreignColumns: [message.tenantId, message.id],
    }),
    check('message_event_status_check', sql.raw(`"status" in (${list(MESSAGE_EVENT_STATUSES)})`)),
    unique('message_event_tenant_id_event_id_key').on(table.tenantId, table.eventId),
  ],
);

/** What became of a reply from a patient. */
export const INBOUND_OUTCOMES = [
  'confirmed',
  'cancelled',
  'opted_out',
  'needs_review',
  'ignored',
] as const;

/**
 * A reply that reached an organization on WhatsApp, by the id of the provider's event (a replayed
 * event is the same reply). It keeps no text: what the patient wrote is only in the encrypted
 * detail of the reception worklist item that asks a person to look at it (`needs_review`), and
 * the sender is a hash. A reply from a number the organization never wrote to is not recorded.
 */
export const inboundMessage = tenantTable(
  'inbound_message',
  {
    eventId: text('event_id').notNull(),
    fromHash: text('from_hash').notNull(),
    outcome: text('outcome').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'inbound_message_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    check('inbound_message_outcome_check', sql.raw(`"outcome" in (${list(INBOUND_OUTCOMES)})`)),
    unique('inbound_message_tenant_id_event_id_key').on(table.tenantId, table.eventId),
  ],
);

/** How the local WhatsApp simulator answers (`/operator/dev/whatsapp/mode`). */
export const LOCAL_WHATSAPP_MODES = ['ok', 'down', 'reject_template'] as const;

export const LOCAL_WHATSAPP_STATUSES = [
  'accepted',
  'sent',
  'delivered',
  'read',
  'failed',
  'received',
] as const;

/**
 * The phone of the local WhatsApp simulator: every message the platform handed to it and every
 * reply typed into it. Platform table, no `tenant_id`: the provider knows nothing about our
 * organizations, and the simulator exists only while `WHATSAPP_PROVIDER=local` (the production
 * guard refuses it otherwise). The API and the worker share it through Postgres.
 */
export const localWhatsappMessage = pgTable(
  'local_whatsapp_message',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    providerMessageId: text('provider_message_id').notNull(),
    /** Sending twice with the same key is one message. Null for a reply. */
    idempotencyKey: text('idempotency_key'),
    direction: text('direction').notNull(),
    /** The recipient of an outbound message, the sender of an inbound one (E.164). */
    number: text('number').notNull(),
    templateKey: text('template_key'),
    /** The text as the patient reads it. */
    body: text('body').notNull(),
    status: text('status').notNull(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex('local_whatsapp_message_provider_id_key').on(table.providerMessageId),
    uniqueIndex('local_whatsapp_message_idempotency_key')
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    check(
      'local_whatsapp_message_direction_check',
      sql`${table.direction} in ('outbound', 'inbound')`,
    ),
    check(
      'local_whatsapp_message_status_check',
      sql.raw(`"status" in (${list(LOCAL_WHATSAPP_STATUSES)})`),
    ),
    index('local_whatsapp_message_created_idx').on(table.createdAt),
  ],
);

/** The one row of controls of the simulator. */
export const localWhatsappControl = pgTable(
  'local_whatsapp_control',
  {
    id: smallint('id').primaryKey().default(1),
    mode: text('mode').notNull().default('ok'),
    /** Numbers the simulator treats as "not on WhatsApp" (the reserved +999 prefix always is). */
    unreachableNumbers: text('unreachable_numbers')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('local_whatsapp_control_single_row_check', sql`${table.id} = 1`),
    check(
      'local_whatsapp_control_mode_check',
      sql.raw(`"mode" in (${list(LOCAL_WHATSAPP_MODES)})`),
    ),
  ],
);

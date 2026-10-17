import {
  WAITLIST_CHANNELS,
  WAITLIST_CLOSE_REASONS,
  WAITLIST_ENTRY_SOURCES,
  WAITLIST_ENTRY_STATUSES,
  WAITLIST_MANUAL_REASONS,
  WAITLIST_OFFER_END_REASONS,
  WAITLIST_OFFER_STATUSES,
  WAITLIST_OPT_IN_SOURCES,
  type WaitlistTimeRange,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { appointmentType } from './scheduling-config.js';
import { appointment } from './scheduling.js';
import { professional } from './staff.js';
import { location, tenant } from './tenant.js';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** Stands for "no professional" and "no location" in the key that keeps an entry unique. */
const NIL = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

/**
 * A patient waiting for a free appointment (waitlist, "Joining the waitlist"). It holds the
 * administrative facts of the wait and nothing clinical: what the patient waits for (a type, and
 * optionally a professional and a location), when they can come, and whether they agreed to
 * receive offers.
 *
 * - `weekdays` (1 Monday to 7 Sunday) and `time_ranges` (local `HH:MM` ranges) are preferences;
 *   empty means no preference.
 * - An entry without the agreement to receive offers, or without a way to reach the patient, is
 *   `manual_contact_only`: it is never offered a slot automatically, reception calls instead.
 * - A patient has at most one entry in play (not closed) for the same type, professional and
 *   location. A closed entry says why, stays for reporting and is never deleted.
 * - `consecutive_expired` counts offers that ran out in a row; at three the entry is `flagged_at`.
 * - `identity_unconfirmed` is set when a public self-join attached the entry to a patient who
 *   already existed (D14): the appointment an accepted offer makes starts with an unconfirmed
 *   identity.
 */
export const waitlistEntry = tenantTable(
  'waitlist_entry',
  {
    patientId: uuid('patient_id').notNull(),
    appointmentTypeId: uuid('appointment_type_id').notNull(),
    professionalId: uuid('professional_id'),
    locationId: uuid('location_id'),
    weekdays: smallint('weekdays')
      .array()
      .notNull()
      .default(sql`'{}'::smallint[]`),
    timeRanges: jsonb('time_ranges')
      .$type<WaitlistTimeRange[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    earliestDate: date('earliest_date', { mode: 'string' }),
    latestDate: date('latest_date', { mode: 'string' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('active'),
    closeReason: text('close_reason'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    manualContactOnly: boolean('manual_contact_only').notNull().default(false),
    manualReason: text('manual_reason'),
    offersOptInAt: timestamp('offers_opt_in_at', { withTimezone: true }),
    offersOptInSource: text('offers_opt_in_source'),
    /** The staff member who recorded the agreement; null when the patient gave it themselves. */
    offersOptInBy: uuid('offers_opt_in_by'),
    channels: text('channels')
      .array()
      .notNull()
      .default(sql`'{email}'::text[]`),
    priority: smallint('priority').notNull().default(0),
    prioritySetAt: timestamp('priority_set_at', { withTimezone: true }),
    prioritySetBy: uuid('priority_set_by'),
    consecutiveExpired: smallint('consecutive_expired').notNull().default(0),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    source: text('source').notNull().default('staff'),
    createdBy: uuid('created_by'),
    identityUnconfirmed: boolean('identity_unconfirmed').notNull().default(false),
  },
  (table) => [
    foreignKey({
      name: 'waitlist_entry_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'waitlist_entry_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'waitlist_entry_type_fkey',
      columns: [table.tenantId, table.appointmentTypeId],
      foreignColumns: [appointmentType.tenantId, appointmentType.id],
    }),
    foreignKey({
      name: 'waitlist_entry_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'waitlist_entry_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('waitlist_entry_status_check', sql.raw(`"status" in (${list(WAITLIST_ENTRY_STATUSES)})`)),
    check(
      'waitlist_entry_close_check',
      sql.raw(
        `("status" = 'closed') = ("close_reason" is not null) and ("status" = 'closed') = ("closed_at" is not null) and ("close_reason" is null or "close_reason" in (${list(WAITLIST_CLOSE_REASONS)}))`,
      ),
    ),
    check(
      'waitlist_entry_manual_check',
      sql.raw(
        `("manual_contact_only") = ("manual_reason" is not null) and ("manual_reason" is null or "manual_reason" in (${list(WAITLIST_MANUAL_REASONS)}))`,
      ),
    ),
    check(
      'waitlist_entry_opt_in_check',
      sql.raw(
        `("offers_opt_in_at" is null) = ("offers_opt_in_source" is null) and ("offers_opt_in_source" is null or "offers_opt_in_source" in (${list(WAITLIST_OPT_IN_SOURCES)})) and ("offers_opt_in_source" is distinct from 'staff' or "offers_opt_in_by" is not null)`,
      ),
    ),
    check('waitlist_entry_source_check', sql.raw(`"source" in (${list(WAITLIST_ENTRY_SOURCES)})`)),
    check(
      'waitlist_entry_channels_check',
      sql.raw(
        `cardinality("channels") between 1 and 2 and "channels" <@ array[${list(WAITLIST_CHANNELS)}]::text[]`,
      ),
    ),
    check('waitlist_entry_priority_check', sql`${table.priority} between 0 and 2`),
    check(
      'waitlist_entry_weekdays_check',
      sql`${table.weekdays} <@ array[1,2,3,4,5,6,7]::smallint[]`,
    ),
    check(
      'waitlist_entry_time_ranges_check',
      sql`jsonb_typeof(${table.timeRanges}) = 'array' and jsonb_array_length(${table.timeRanges}) <= 6`,
    ),
    check(
      'waitlist_entry_dates_check',
      sql`${table.earliestDate} is null or ${table.latestDate} is null or ${table.earliestDate} <= ${table.latestDate}`,
    ),
    check('waitlist_entry_expired_count_check', sql`${table.consecutiveExpired} >= 0`),
    // One entry in play per patient, type, professional and location.
    uniqueIndex('waitlist_entry_in_play_key')
      .on(
        table.tenantId,
        table.patientId,
        table.appointmentTypeId,
        sql`coalesce(${table.professionalId}, ${NIL})`,
        sql`coalesce(${table.locationId}, ${NIL})`,
      )
      .where(sql`${table.status} <> 'closed'`),
    // What matching reads: the entries still waiting for a type.
    index('waitlist_entry_matching_idx')
      .on(table.tenantId, table.appointmentTypeId, table.expiresAt)
      .where(sql`${table.status} = 'active'`),
    index('waitlist_entry_patient_idx').on(table.tenantId, table.patientId, table.status),
  ],
);

export type WaitlistEntryRow = typeof waitlistEntry.$inferSelect;

/**
 * One slot offered to one entry (waitlist, "Offers with expiry"). `slot_key` names the slot
 * (professional, location and start), so an entry cannot be offered the same slot twice and a
 * patient with two entries is not offered it twice. At most one offer per slot is open at a time.
 *
 * - `freed_*` is the range that was freed, kept so the next entry can be offered the same slot
 *   when this offer is declined or expires.
 * - `send_at` is when delivery is due: now, or the end of quiet hours.
 * - The outcome of an offer (accepted, declined, expired, invalidated and why) and its closing
 *   time stay for the reports of recovered slots. An offer is never deleted.
 */
export const waitlistOffer = tenantTable(
  'waitlist_offer',
  {
    entryId: uuid('entry_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    slotKey: text('slot_key').notNull(),
    professionalId: uuid('professional_id').notNull(),
    locationId: uuid('location_id').notNull(),
    appointmentTypeId: uuid('appointment_type_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    freedStartsAt: timestamp('freed_starts_at', { withTimezone: true }).notNull(),
    freedEndsAt: timestamp('freed_ends_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('open'),
    endReason: text('end_reason'),
    sendAt: timestamp('send_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    channel: text('channel'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    messageId: text('message_id'),
    appointmentId: uuid('appointment_id'),
  },
  (table) => [
    foreignKey({
      name: 'waitlist_offer_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'waitlist_offer_entry_fkey',
      columns: [table.tenantId, table.entryId],
      foreignColumns: [waitlistEntry.tenantId, waitlistEntry.id],
    }),
    foreignKey({
      name: 'waitlist_offer_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'waitlist_offer_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'waitlist_offer_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: 'waitlist_offer_type_fkey',
      columns: [table.tenantId, table.appointmentTypeId],
      foreignColumns: [appointmentType.tenantId, appointmentType.id],
    }),
    foreignKey({
      name: 'waitlist_offer_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    check('waitlist_offer_status_check', sql.raw(`"status" in (${list(WAITLIST_OFFER_STATUSES)})`)),
    check(
      'waitlist_offer_end_check',
      sql.raw(
        `("status" = 'open') = ("closed_at" is null) and ("end_reason" is null or "end_reason" in (${list(WAITLIST_OFFER_END_REASONS)}))`,
      ),
    ),
    check(
      'waitlist_offer_channel_check',
      sql.raw(`"channel" is null or "channel" in (${list(WAITLIST_CHANNELS)})`),
    ),
    check('waitlist_offer_range_check', sql`${table.endsAt} > ${table.startsAt}`),
    // The same slot is never offered to the same entry, or to the same patient, twice.
    uniqueIndex('waitlist_offer_entry_slot_key').on(table.tenantId, table.entryId, table.slotKey),
    uniqueIndex('waitlist_offer_patient_slot_key').on(
      table.tenantId,
      table.patientId,
      table.slotKey,
    ),
    // One open offer per slot.
    uniqueIndex('waitlist_offer_open_slot_key')
      .on(table.tenantId, table.slotKey)
      .where(sql`${table.status} = 'open'`),
    index('waitlist_offer_entry_idx').on(table.tenantId, table.entryId, table.createdAt),
    index('waitlist_offer_due_idx')
      .on(table.expiresAt)
      .where(sql`${table.status} = 'open'`),
  ],
);

export type WaitlistOfferRow = typeof waitlistOffer.$inferSelect;

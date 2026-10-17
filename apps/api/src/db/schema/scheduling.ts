import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
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
import { professional } from './staff.js';
import { location, tenant } from './tenant.js';

/** Free-form JSON object columns. Their shapes are validated in the API. */
type JsonObject = Record<string, unknown>;

/** PostgreSQL `tstzrange`, kept as its text form (`[2026-01-01 10:00+00,2026-01-01 10:30+00)`). */
export const tstzrange = customType<{ data: string; driverData: string }>({
  dataType: () => 'tstzrange',
});

/** The eight appointment statuses (scheduling, "Attendance lifecycle"). No others exist. */
export const APPOINTMENT_STATUS_VALUES = [
  'pending_approval',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'attended',
  'no_show',
  'cancelled',
] as const;

const STATUS_LIST = APPOINTMENT_STATUS_VALUES.map((status) => `'${status}'`).join(', ');

/**
 * An appointment: a professional's time given to a patient. It holds administrative data only,
 * never clinical content. Times are absolute instants, rendered in the location's time zone.
 *
 * - `buffer_minutes` and the duration are copied from the type when it is booked, so editing a
 *   type later does not move the past.
 * - `lane` is the professional's slot (1 unless overbooking is on); a trigger mirrors the
 *   appointment into `slot_occupancy`, where the database refuses overlaps per lane.
 * - `identity_confirmed` is false when nobody has checked who the patient is (decision D14); a
 *   false value keeps the appointment out of the care relationship.
 * - `version` is bumped on every change; stale writers get 409.
 * - An appointment is never deleted, only cancelled.
 */
export const appointment = tenantTable(
  'appointment',
  {
    patientId: uuid('patient_id').notNull(),
    professionalId: uuid('professional_id').notNull(),
    locationId: uuid('location_id').notNull(),
    appointmentTypeId: uuid('appointment_type_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    bufferMinutes: smallint('buffer_minutes').notNull().default(0),
    lane: smallint('lane').notNull().default(1),
    status: text('status').notNull().default('scheduled'),
    source: text('source').notNull().default('staff'),
    /** Null for online bookings. */
    bookedBy: uuid('booked_by'),
    identityConfirmed: boolean('identity_confirmed').notNull().default(true),
    identityConfirmedBy: uuid('identity_confirmed_by'),
    /** How a pending identity was confirmed; null when it never needed confirming. */
    identityConfirmation: text('identity_confirmation'),
    outOfHours: boolean('out_of_hours').notNull().default(false),
    overrideReason: text('override_reason'),
    videoRoom: text('video_room'),
    seriesId: uuid('series_id'),
    seriesIndex: smallint('series_index'),
    cancelledByKind: text('cancelled_by_kind'),
    cancelReason: text('cancel_reason'),
    cancelNote: text('cancel_note'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    lateCancellation: boolean('late_cancellation'),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'appointment_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'appointment_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'appointment_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'appointment_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: 'appointment_type_fkey',
      columns: [table.tenantId, table.appointmentTypeId],
      foreignColumns: [appointmentType.tenantId, appointmentType.id],
    }),
    check('appointment_status_check', sql.raw(`"status" in (${STATUS_LIST})`)),
    check(
      'appointment_source_check',
      sql`${table.source} in ('staff', 'online', 'waitlist_offer')`,
    ),
    check('appointment_interval_check', sql`${table.endsAt} > ${table.startsAt}`),
    check('appointment_buffer_check', sql`${table.bufferMinutes} >= 0`),
    check('appointment_lane_check', sql`${table.lane} >= 1`),
    check('appointment_version_check', sql`${table.version} >= 1`),
    check(
      'appointment_identity_check',
      sql`${table.identityConfirmation} is null
        or (${table.identityConfirmed} and ${table.identityConfirmation} in ('staff', 'self_confirmed'))`,
    ),
    check(
      'appointment_cancelled_by_check',
      sql`${table.cancelledByKind} is null or ${table.cancelledByKind} in ('patient', 'professional', 'organization')`,
    ),
    index('appointment_professional_time_idx').on(
      table.tenantId,
      table.professionalId,
      table.startsAt,
    ),
    index('appointment_location_time_idx').on(table.tenantId, table.locationId, table.startsAt),
    index('appointment_patient_time_idx').on(table.tenantId, table.patientId, table.startsAt),
    index('appointment_series_idx')
      .on(table.tenantId, table.seriesId, table.seriesIndex)
      .where(sql`${table.seriesId} is not null`),
  ],
);

export type AppointmentRow = typeof appointment.$inferSelect;

/**
 * What happened to an appointment, in order. A reschedule is an event here, not a status
 * ("Rescheduled" is derived from history). The runtime role can insert but never change or delete
 * a row (migration 0025), so the history cannot be rewritten.
 */
export const appointmentEvent = tenantTable(
  'appointment_event',
  {
    appointmentId: uuid('appointment_id').notNull(),
    kind: text('kind').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    /** Null for the system (a job). */
    actorUserId: uuid('actor_user_id'),
    actorKind: text('actor_kind').notNull().default('staff'),
    /** Administrative facts of the change: previous time, professional, reason code. No clinical content. */
    details: jsonb('details').$type<JsonObject>().notNull().default({}),
  },
  (table) => [
    foreignKey({
      name: 'appointment_event_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'appointment_event_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    check(
      'appointment_event_kind_check',
      sql`${table.kind} in ('created', 'status_changed', 'rescheduled', 'reassigned', 'status_corrected', 'identity_confirmed', 'identity_rejected')`,
    ),
    check(
      'appointment_event_actor_kind_check',
      sql`${table.actorKind} in ('staff', 'patient', 'system')`,
    ),
    index('appointment_event_appointment_idx').on(
      table.tenantId,
      table.appointmentId,
      table.createdAt,
    ),
  ],
);

export type AppointmentEventRow = typeof appointmentEvent.$inferSelect;

/**
 * A short reservation of a professional's time while someone completes a booking. It has no
 * patient and no appointment status, and it is never deleted: it ends as `converted`, `expired`,
 * `released` (its holder replaced it) or `invalidated` (staff booked over it). While `active` it
 * occupies time exactly like an appointment does.
 */
export const slotHold = tenantTable(
  'slot_hold',
  {
    professionalId: uuid('professional_id').notNull(),
    locationId: uuid('location_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    bufferMinutes: smallint('buffer_minutes').notNull().default(0),
    lane: smallint('lane').notNull().default(1),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    origin: text('origin').notNull().default('staff'),
    /** Hash of the anonymous booking session (public) or the user id (staff). */
    sourceKey: text('source_key').notNull(),
    /** The appointment a hold was converted into. */
    appointmentId: uuid('appointment_id'),
    createdBy: uuid('created_by'),
  },
  (table) => [
    foreignKey({
      name: 'slot_hold_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'slot_hold_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'slot_hold_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: 'slot_hold_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    check(
      'slot_hold_status_check',
      sql`${table.status} in ('active', 'converted', 'expired', 'released', 'invalidated')`,
    ),
    check('slot_hold_origin_check', sql`${table.origin} in ('public', 'staff')`),
    check('slot_hold_interval_check', sql`${table.endsAt} > ${table.startsAt}`),
    check('slot_hold_buffer_check', sql`${table.bufferMinutes} >= 0`),
    check('slot_hold_lane_check', sql`${table.lane} >= 1`),
    index('slot_hold_active_idx')
      .on(table.tenantId, table.professionalId, table.expiresAt)
      .where(sql`${table.status} = 'active'`),
    index('slot_hold_source_idx')
      .on(table.tenantId, table.sourceKey, table.createdAt)
      .where(sql`${table.status} = 'active'`),
  ],
);

export type SlotHoldRow = typeof slotHold.$inferSelect;

/**
 * The single conflict surface for appointments AND holds (design 4.6). Each occupying appointment
 * or hold has one row here, kept in step by triggers (migration 0025); the application role cannot
 * write the table. An exclusion constraint refuses two ACTIVE rows of one professional whose
 * ranges overlap in the same lane, so a double booking is impossible whatever the application
 * does; capacity is the number of lanes (`professional.max_simultaneous`). `during` runs from the
 * start to the end PLUS the buffer, so back-to-back is allowed and a buffer blocks the next start.
 */
export const slotOccupancy = tenantTable(
  'slot_occupancy',
  {
    professionalId: uuid('professional_id').notNull(),
    locationId: uuid('location_id').notNull(),
    lane: smallint('lane').notNull(),
    during: tstzrange('during').notNull(),
    active: boolean('active').notNull(),
    appointmentId: uuid('appointment_id'),
    slotHoldId: uuid('slot_hold_id'),
  },
  (table) => [
    foreignKey({
      name: 'slot_occupancy_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'slot_occupancy_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'slot_occupancy_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: 'slot_occupancy_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    foreignKey({
      name: 'slot_occupancy_hold_fkey',
      columns: [table.tenantId, table.slotHoldId],
      foreignColumns: [slotHold.tenantId, slotHold.id],
    }),
    check('slot_occupancy_lane_check', sql`${table.lane} >= 1`),
    check(
      'slot_occupancy_owner_check',
      sql`num_nonnulls(${table.appointmentId}, ${table.slotHoldId}) = 1`,
    ),
    uniqueIndex('slot_occupancy_appointment_key')
      .on(table.appointmentId)
      .where(sql`${table.appointmentId} is not null`),
    uniqueIndex('slot_occupancy_hold_key')
      .on(table.slotHoldId)
      .where(sql`${table.slotHoldId} is not null`),
    index('slot_occupancy_active_idx')
      .on(table.tenantId, table.professionalId)
      .where(sql`${table.active}`),
  ],
);

export type SlotOccupancyRow = typeof slotOccupancy.$inferSelect;

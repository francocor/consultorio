import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { professional } from './staff.js';
import { location, tenant } from './tenant.js';

/**
 * What an organization offers to book (scheduling, "Appointment types"). A type is deactivated,
 * never deleted, and deactivating it changes nothing about the appointments that already use it.
 * An appointment copies the duration and buffer when it is booked, so editing a type later does not
 * move the past.
 *
 * `professional_ids` and `specialties` restrict who may offer the type; both empty means everyone.
 * They are arrays (no foreign keys), so the service checks them against the organization.
 */
export const appointmentType = tenantTable(
  'appointment_type',
  {
    name: text('name').notNull(),
    description: text('description'),
    durationMinutes: smallint('duration_minutes').notNull(),
    /** Preparation or cleanup time after the appointment: it occupies the professional but is not part of the visit. */
    bufferMinutes: smallint('buffer_minutes').notNull().default(0),
    mode: text('mode').notNull().default('in_person'),
    /** A reference resolved by billing; scheduling never reads a price. */
    priceReference: text('price_reference'),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    color: text('color'),
    professionalIds: uuid('professional_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    specialties: text('specialties')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    active: boolean('active').notNull().default(true),
  },
  (table) => [
    foreignKey({
      name: 'appointment_type_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    check(
      'appointment_type_duration_check',
      sql`${table.durationMinutes} > 0 and ${table.durationMinutes} <= 1440`,
    ),
    check(
      'appointment_type_buffer_check',
      sql`${table.bufferMinutes} >= 0 and ${table.bufferMinutes} <= 1440`,
    ),
    check('appointment_type_mode_check', sql`${table.mode} in ('in_person', 'virtual')`),
    check(
      'appointment_type_color_check',
      sql`${table.color} is null or ${table.color} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
    index('appointment_type_active_idx')
      .on(table.tenantId, table.name)
      .where(sql`${table.active}`),
  ],
);

export type AppointmentTypeRow = typeof appointmentType.$inferSelect;

/**
 * A non-bookable interval (scheduling, "Blocks and holidays") for a professional, a whole
 * location, or a professional at one location. A recurring block is stored as one row per
 * occurrence that share a `series_id`, so each occurrence can be removed on its own. A block is
 * removed (`removed_at`), never deleted.
 */
export const scheduleBlock = tenantTable(
  'schedule_block',
  {
    professionalId: uuid('professional_id'),
    locationId: uuid('location_id'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    seriesId: uuid('series_id'),
    createdBy: uuid('created_by').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: uuid('removed_by'),
  },
  (table) => [
    foreignKey({
      name: 'schedule_block_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'schedule_block_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'schedule_block_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('schedule_block_interval_check', sql`${table.endsAt} > ${table.startsAt}`),
    check(
      'schedule_block_scope_check',
      sql`${table.professionalId} is not null or ${table.locationId} is not null`,
    ),
    index('schedule_block_live_idx')
      .on(table.tenantId, table.startsAt)
      .where(sql`${table.removedAt} is null`),
  ],
);

export type ScheduleBlockRow = typeof scheduleBlock.$inferSelect;

/**
 * A day the organization does not work, on top of the national holiday catalog (country-rules-ar,
 * "Holiday catalog"): a provincial or local holiday, a closure. `location_id` null means the whole
 * organization. The date is a calendar date; it is read in each location's time zone.
 */
export const tenantDayOff = tenantTable(
  'tenant_day_off',
  {
    day: date('day', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    locationId: uuid('location_id'),
    createdBy: uuid('created_by').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: uuid('removed_by'),
  },
  (table) => [
    foreignKey({
      name: 'tenant_day_off_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'tenant_day_off_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    uniqueIndex('tenant_day_off_live_idx')
      .on(
        table.tenantId,
        table.day,
        sql`coalesce(${table.locationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${table.removedAt} is null`),
  ],
);

export type TenantDayOffRow = typeof tenantDayOff.$inferSelect;

/**
 * Working hours that apply to a range of dates and take precedence over the weekly default
 * (`professional_hours`) for that range (scheduling, "Working hours and out-of-hours bookings").
 * One period is the rows that share a `period_id`: each row is an interval of one weekday at one
 * location, in that location's time zone. A period with no interval (one marker row with every
 * interval column null) means the professional does not work in that range. Periods are removed
 * (`removed_at`), never deleted.
 */
export const professionalHoursException = tenantTable(
  'professional_hours_exception',
  {
    professionalId: uuid('professional_id').notNull(),
    periodId: uuid('period_id').notNull(),
    dateFrom: date('date_from', { mode: 'string' }).notNull(),
    dateTo: date('date_to', { mode: 'string' }).notNull(),
    reason: text('reason'),
    locationId: uuid('location_id'),
    /** ISO weekday: 1 is Monday, 7 is Sunday. */
    weekday: smallint('weekday'),
    startMinute: smallint('start_minute'),
    endMinute: smallint('end_minute'),
    createdBy: uuid('created_by').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'professional_hours_exception_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'professional_hours_exception_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'professional_hours_exception_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('professional_hours_exception_range_check', sql`${table.dateTo} >= ${table.dateFrom}`),
    check(
      'professional_hours_exception_interval_check',
      sql`(${table.locationId} is null and ${table.weekday} is null and ${table.startMinute} is null and ${table.endMinute} is null)
        or (${table.locationId} is not null and ${table.weekday} is not null
            and ${table.startMinute} is not null and ${table.endMinute} is not null
            and ${table.weekday} between 1 and 7 and ${table.startMinute} >= 0 and ${table.endMinute} <= 1440 and ${table.endMinute} > ${table.startMinute})`,
    ),
    index('professional_hours_exception_live_idx')
      .on(table.tenantId, table.professionalId, table.dateFrom)
      .where(sql`${table.removedAt} is null`),
  ],
);

export type ProfessionalHoursExceptionRow = typeof professionalHoursException.$inferSelect;

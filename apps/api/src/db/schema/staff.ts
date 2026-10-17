import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { membership } from './identity.js';
import { location, tenant } from './tenant.js';

/**
 * The professional profile of a member (staff-professionals, "Professional profile"). A member with
 * the `professional` role and an ACTIVE profile with a recorded matricula of a valid format is a
 * health professional: that is the clinical gate, and nothing else opens it.
 *
 * `matricula_status` is `unverified` until the platform operator verifies the registration (only
 * e-prescription needs it). A trigger (migration 0013) refuses `verified` from any role but
 * `app_operator`, and resets it to `unverified` when the number or jurisdiction changes, so not
 * even a bug in the application can let a tenant user verify.
 */
export const professional = tenantTable(
  'professional',
  {
    membershipId: uuid('membership_id').notNull(),
    status: text('status').notNull().default('active'),
    matricula: text('matricula'),
    matriculaJurisdiction: text('matricula_jurisdiction'),
    matriculaStatus: text('matricula_status').notNull().default('unverified'),
    verifiedByOperator: uuid('verified_by_operator'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** 1 means no overbooking; a higher number lets that many appointments share a slot. */
    maxSimultaneous: smallint('max_simultaneous').notNull().default(1),
    /** One or more disciplines; the product never infers a discipline from the role. */
    specialties: text('specialties')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (table) => [
    foreignKey({
      name: 'professional_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'professional_membership_fkey',
      columns: [table.tenantId, table.membershipId],
      foreignColumns: [membership.tenantId, membership.id],
    }),
    unique('professional_tenant_id_membership_id_key').on(table.tenantId, table.membershipId),
    check('professional_status_check', sql`${table.status} in ('active', 'inactive')`),
    check(
      'professional_matricula_status_check',
      sql`${table.matriculaStatus} in ('unverified', 'verified')`,
    ),
    check(
      'professional_matricula_pair_check',
      sql`(${table.matricula} is null) = (${table.matriculaJurisdiction} is null)`,
    ),
    check(
      'professional_verified_check',
      sql`${table.matriculaStatus} = 'unverified' or (${table.matricula} is not null and ${table.verifiedByOperator} is not null)`,
    ),
    check('professional_max_simultaneous_check', sql`${table.maxSimultaneous} between 1 and 20`),
    // Within an organization a registration belongs to one ACTIVE professional.
    uniqueIndex('professional_matricula_active_key')
      .on(table.tenantId, table.matriculaJurisdiction, table.matricula)
      .where(sql`${table.status} = 'active' and ${table.matricula} is not null`),
  ],
);

export type ProfessionalRow = typeof professional.$inferSelect;

/**
 * Recurring weekly working hours of a professional at a location. Times are minutes since local
 * midnight in THAT LOCATION's time zone (authoritative). Replacing the hours ends the old rows
 * (`removed_at`) instead of deleting them.
 */
export const professionalHours = tenantTable(
  'professional_hours',
  {
    professionalId: uuid('professional_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** ISO weekday: 1 is Monday, 7 is Sunday. */
    weekday: smallint('weekday').notNull(),
    startMinute: smallint('start_minute').notNull(),
    endMinute: smallint('end_minute').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'professional_hours_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'professional_hours_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'professional_hours_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('professional_hours_weekday_check', sql`${table.weekday} between 1 and 7`),
    check(
      'professional_hours_interval_check',
      sql`${table.startMinute} >= 0 and ${table.endMinute} <= 1440 and ${table.endMinute} > ${table.startMinute}`,
    ),
    index('professional_hours_live_idx')
      .on(table.tenantId, table.professionalId)
      .where(sql`${table.removedAt} is null`),
  ],
);

export type ProfessionalHoursRow = typeof professionalHours.$inferSelect;

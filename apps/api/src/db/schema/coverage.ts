import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { payer } from './platform-catalogs.js';
import { tenant } from './tenant.js';

/**
 * A payer the organization works with, optionally narrowed to a plan. It points at the platform
 * catalog (`payer_id`: obras sociales, prepagas and "Particular") or is a custom entry of this
 * organization (`custom_name`); exactly one of the two. Custom entries are tenant-owned, so another
 * organization never sees them. Deactivated, never deleted: coverages keep pointing at it.
 */
export const payerPlan = tenantTable(
  'payer_plan',
  {
    payerId: uuid('payer_id'),
    customName: text('custom_name'),
    planName: text('plan_name'),
    active: boolean('active').notNull().default(true),
  },
  (table) => [
    foreignKey({
      name: 'payer_plan_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'payer_plan_payer_id_fkey',
      columns: [table.payerId],
      foreignColumns: [payer.id],
    }),
    check(
      'payer_plan_one_source_check',
      sql`(${table.payerId} is null) <> (${table.customName} is null)`,
    ),
    // The same payer and plan is enabled once.
    uniqueIndex('payer_plan_catalog_key')
      .on(table.tenantId, table.payerId, sql`coalesce(${table.planName}, '')`)
      .where(sql`${table.payerId} is not null`),
    uniqueIndex('payer_plan_custom_key')
      .on(table.tenantId, sql`lower(${table.customName})`, sql`coalesce(${table.planName}, '')`)
      .where(sql`${table.customName} is not null`),
  ],
);

export type PayerPlanRow = typeof payerPlan.$inferSelect;

/**
 * A coverage of a patient: payer plan, member number, validity and whether it is the primary one.
 * An edit does not overwrite: the old row is ended (`ended_at`, with its reason) and a new row
 * carries the new values, so prior values are kept (patients, "Patient data changes versioned and
 * audited"). At most one primary coverage per patient is live at a time.
 */
export const patientCoverage = tenantTable(
  'patient_coverage',
  {
    patientId: uuid('patient_id').notNull(),
    payerPlanId: uuid('payer_plan_id').notNull(),
    memberNumber: text('member_number'),
    validFrom: date('valid_from', { mode: 'string' }),
    validTo: date('valid_to', { mode: 'string' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** `replaced` when an edit superseded it, `removed` when staff took it off the patient. */
    endReason: text('end_reason'),
  },
  (table) => [
    foreignKey({
      name: 'patient_coverage_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'patient_coverage_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'patient_coverage_payer_plan_fkey',
      columns: [table.tenantId, table.payerPlanId],
      foreignColumns: [payerPlan.tenantId, payerPlan.id],
    }),
    check(
      'patient_coverage_dates_check',
      sql`${table.validFrom} is null or ${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`,
    ),
    check(
      'patient_coverage_end_check',
      sql`(${table.endedAt} is null) = (${table.endReason} is null) and (${table.endReason} is null or ${table.endReason} in ('replaced', 'removed'))`,
    ),
    uniqueIndex('patient_coverage_primary_key')
      .on(table.tenantId, table.patientId)
      .where(sql`${table.isPrimary} and ${table.endedAt} is null`),
    index('patient_coverage_live_idx')
      .on(table.tenantId, table.patientId)
      .where(sql`${table.endedAt} is null`),
  ],
);

export type PatientCoverageRow = typeof patientCoverage.$inferSelect;

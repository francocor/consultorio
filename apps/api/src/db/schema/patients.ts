import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { citext, tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

type JsonObject = Record<string, unknown>;

/**
 * A person the organization cares for. Demographics belong to the whole organization (every
 * professional and every reception user reads them), so row level security is tenant-only;
 * clinical content about the patient lives in other tables, scoped by care relationship.
 *
 * - The document is optional. Where there is one, `(tenant, type, number)` is unique, so the same
 *   person cannot be registered twice; a newborn without a document is never blocked by it.
 * - `safety_flags` holds CODES only and is written by one SECURITY DEFINER function, from the
 *   anamnesis (S1.22). A trigger rejects any other write.
 * - A patient is deactivated, never deleted.
 */
export const patient = tenantTable(
  'patient',
  {
    familyName: text('family_name').notNull(),
    givenNames: text('given_names').notNull(),
    birthDate: date('birth_date', { mode: 'string' }).notNull(),
    sex: text('sex'),
    nationalIdType: text('national_id_type'),
    nationalId: text('national_id'),
    phone: text('phone'),
    email: citext('email'),
    address: text('address'),
    emergencyContactName: text('emergency_contact_name'),
    emergencyContactPhone: text('emergency_contact_phone'),
    adminNotes: text('admin_notes'),
    safetyFlags: text('safety_flags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    origin: text('origin').notNull().default('staff'),
    status: text('status').notNull().default('active'),
    /** Starts at 1; every change to the demographics writes the next `patient_version`. */
    version: integer('version').notNull().default(1),
    /** Name without accents and in lower case: what the search compares against. */
    searchName: text('search_name')
      .notNull()
      .generatedAlwaysAs(sql`lower(app.f_unaccent(family_name || ' ' || given_names))`),
    /** Digits of the phone number, for searching by phone however it was typed. */
    phoneDigits: text('phone_digits')
      .notNull()
      .generatedAlwaysAs(sql`regexp_replace(coalesce(phone, ''), '\\D', '', 'g')`),
  },
  (table) => [
    foreignKey({
      name: 'patient_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    check(
      'patient_document_pair_check',
      sql`(${table.nationalIdType} is null) = (${table.nationalId} is null)`,
    ),
    check(
      'patient_sex_check',
      sql`${table.sex} is null or ${table.sex} in ('female', 'male', 'non_binary', 'undisclosed')`,
    ),
    check('patient_origin_check', sql`${table.origin} in ('staff', 'online')`),
    check('patient_status_check', sql`${table.status} in ('active', 'inactive')`),
    check('patient_version_check', sql`${table.version} >= 1`),
    // Deduplication by document: only where a document exists.
    uniqueIndex('patient_document_key')
      .on(table.tenantId, table.nationalIdType, table.nationalId)
      .where(sql`${table.nationalId} is not null`),
    index('patient_name_order_idx').on(
      table.tenantId,
      table.familyName,
      table.givenNames,
      table.id,
    ),
    index('patient_search_name_idx').using('gin', table.searchName.op('gin_trgm_ops')),
    index('patient_phone_digits_idx').on(table.tenantId, table.phoneDigits),
    index('patient_national_id_idx').on(table.tenantId, table.nationalId),
  ],
);

export type PatientRow = typeof patient.$inferSelect;

/**
 * One row per state of the demographics: version 1 is the registration and every change adds the
 * next. Prior values are never overwritten, and the runtime role cannot update or delete a row.
 */
export const patientVersion = tenantTable(
  'patient_version',
  {
    patientId: uuid('patient_id').notNull(),
    version: integer('version').notNull(),
    changedBy: uuid('changed_by'),
    changedFields: text('changed_fields')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The demographics as they were at this version. */
    snapshot: jsonb('snapshot').$type<JsonObject>().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'patient_version_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'patient_version_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    unique('patient_version_tenant_id_patient_id_version_key').on(
      table.tenantId,
      table.patientId,
      table.version,
    ),
  ],
);

export type PatientVersionRow = typeof patientVersion.$inferSelect;

/**
 * A guardian or other contact of a minor, recorded as an ADMINISTRATIVE contact only: it gives no
 * access to the patient's data. `majority_review_on` is the day the patient reaches the age of
 * majority of the country pack, when the arrangement is reviewed. Ended, never deleted.
 */
export const patientRepresentative = tenantTable(
  'patient_representative',
  {
    patientId: uuid('patient_id').notNull(),
    fullName: text('full_name').notNull(),
    relation: text('relation').notNull(),
    phone: text('phone'),
    email: citext('email'),
    majorityReviewOn: date('majority_review_on', { mode: 'string' }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'patient_representative_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'patient_representative_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    check(
      'patient_representative_relation_check',
      sql`${table.relation} in ('mother', 'father', 'guardian', 'other')`,
    ),
    check(
      'patient_representative_contact_check',
      sql`${table.phone} is not null or ${table.email} is not null`,
    ),
    index('patient_representative_live_idx')
      .on(table.tenantId, table.patientId)
      .where(sql`${table.endedAt} is null`),
  ],
);

export type PatientRepresentativeRow = typeof patientRepresentative.$inferSelect;

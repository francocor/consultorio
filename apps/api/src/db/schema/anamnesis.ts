import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text, unique, uuid } from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

/**
 * The anamnesis of a patient: CLINICAL data. Each save is a new immutable version; the content is
 * encrypted with the tenant's data key (AES-256-GCM, bound to this table, column and row), so a
 * database dump or an operator with SQL access reads ciphertext only.
 *
 * Two RESTRICTIVE policies (`clinicalPolicies`, migration 0016) add to the tenant isolation: only
 * a health professional's transaction sees any row, and only the ones the care relationship and the
 * sharing scope allow. An owner, an admin or reception sees zero rows even if the application had
 * a bug. Anamnesis follows the general ceiling of the sharing scope (not a template entry).
 */
export const anamnesis = tenantTable(
  'anamnesis',
  {
    patientId: uuid('patient_id').notNull(),
    version: integer('version').notNull(),
    authorProfessionalId: uuid('author_professional_id').notNull(),
    /** Read by the clinical policy; anamnesis has no restricted-to-author mode. */
    visibility: text('visibility').notNull().default('default'),
    contentEnc: bytea('content_enc').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'anamnesis_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'anamnesis_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'anamnesis_author_fkey',
      columns: [table.tenantId, table.authorProfessionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    unique('anamnesis_tenant_id_patient_id_version_key').on(
      table.tenantId,
      table.patientId,
      table.version,
    ),
    check('anamnesis_version_check', sql`${table.version} >= 1`),
    check('anamnesis_visibility_check', sql`${table.visibility} = 'default'`),
    index('anamnesis_latest_idx').on(table.tenantId, table.patientId, table.version),
  ],
);

export type AnamnesisRow = typeof anamnesis.$inferSelect;

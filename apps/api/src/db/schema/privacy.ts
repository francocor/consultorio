import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { tenant } from './tenant.js';

/**
 * The data-processing consent of a patient (Ley 25.326), tied to the exact text version they
 * accepted. A revocation ends the row (`revoked_at`); a new grant is a new row, so the history of
 * who consented to what, and when, is never overwritten. At most one consent is live per patient.
 */
export const dataProcessingConsent = tenantTable(
  'data_processing_consent',
  {
    patientId: uuid('patient_id').notNull(),
    /** i18n key of the consent text, from the country pack. */
    textKey: text('text_key').notNull(),
    /** Changes whenever the text does. */
    textVersion: text('text_version').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
  },
  (table) => [
    foreignKey({
      name: 'data_processing_consent_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'data_processing_consent_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    check(
      'data_processing_consent_revocation_check',
      sql`(${table.revokedAt} is null) = (${table.revokedBy} is null)`,
    ),
    uniqueIndex('data_processing_consent_live_key')
      .on(table.tenantId, table.patientId)
      .where(sql`${table.revokedAt} is null`),
    index('data_processing_consent_patient_idx').on(
      table.tenantId,
      table.patientId,
      table.grantedAt,
    ),
  ],
);

export type DataProcessingConsentRow = typeof dataProcessingConsent.$inferSelect;

/**
 * A patient's request to access or rectify their personal data (Ley 25.326), logged by staff and
 * fulfilled by staff. A rectification goes through the versioned update of the patient, so the
 * previous value stays in the history. The note is short and administrative; clinical content
 * never goes in it.
 */
export const patientRightsRequest = tenantTable(
  'patient_rights_request',
  {
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('open'),
    requestedBy: uuid('requested_by').notNull(),
    note: text('note'),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfilledBy: uuid('fulfilled_by'),
  },
  (table) => [
    foreignKey({
      name: 'patient_rights_request_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'patient_rights_request_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    check('patient_rights_request_kind_check', sql`${table.kind} in ('access', 'rectification')`),
    check('patient_rights_request_status_check', sql`${table.status} in ('open', 'fulfilled')`),
    check(
      'patient_rights_request_fulfilled_check',
      sql`(${table.status} = 'fulfilled') = (${table.fulfilledAt} is not null and ${table.fulfilledBy} is not null)`,
    ),
    index('patient_rights_request_patient_idx').on(
      table.tenantId,
      table.patientId,
      table.createdAt,
    ),
  ],
);

export type PatientRightsRequestRow = typeof patientRightsRequest.$inferSelect;

import {
  ALL_DOCUMENT_CATEGORIES,
  DOCUMENT_CATEGORIES,
  DOCUMENT_CLASSIFICATIONS,
  DOCUMENT_CONTENT_TYPES,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_REJECTION_REASONS,
  DOCUMENT_STATUSES,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { encounter } from './clinical.js';
import { patient } from './patients.js';
import { appointment } from './scheduling.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * A file attached to a patient. The file itself lives in object storage under `object_key`; this
 * row is its metadata and its state. A document is never deleted and its content never changes
 * (documents, "Immutability, replacement and removal"): a corrected file is a NEW row that points
 * at the one it replaces, and a wrongly uploaded one is hidden with a reason.
 *
 * Lifecycle: `quarantined` (uploaded, or about to be, and waiting for the scan) then `available`
 * (clean, downloadable) or `rejected` (infected or not an allowed type, never downloadable);
 * `available` can become `hidden`. The database enforces the transitions (migration 0029, and 0036 for the classification).
 *
 * Access follows the classification. An administrative document is visible to the staff of the
 * organization; a clinical one only to a health professional who may read it (the same rule as a
 * clinical note, through the RESTRICTIVE policy `document_classification`), so an owner, an admin
 * or reception reads zero clinical rows even if the application had a bug. Background jobs act as
 * the system user and see both, to scan them.
 *
 * `appointment_id` points at the appointment the document came with (same organization, by the
 * composite key), and `encounter_id` at the encounter the document belongs to (same organization).
 */
export const document = tenantTable(
  'document',
  {
    patientId: uuid('patient_id').notNull(),
    encounterId: uuid('encounter_id'),
    appointmentId: uuid('appointment_id'),
    category: text('category').notNull(),
    classification: text('classification').notNull(),
    /** The name as the user's computer showed it, cleaned of path parts. Never a storage path. */
    originalName: text('original_name').notNull(),
    declaredContentType: text('declared_content_type').notNull(),
    /** The type the CONTENT has, set by the scan. Null until then. */
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status').notNull().default('quarantined'),
    /** `t/{tenantId}/quarantine/{id}` until the scan passes, then `t/{tenantId}/docs/{id}`. */
    objectKey: text('object_key').notNull(),
    sha256: text('sha256'),
    scanResult: text('scan_result'),
    rejectionReason: text('rejection_reason'),
    scanAttempts: integer('scan_attempts').notNull().default(0),
    /** How many times the scan found the object changed after it was scanned and started over. */
    rescanAttempts: integer('rescan_attempts').notNull().default(0),
    lastScanErrorAt: timestamp('last_scan_error_at', { withTimezone: true }),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),
    /** Set when the uploader confirms the file reached storage. Until then the row is invisible. */
    uploadCompletedAt: timestamp('upload_completed_at', { withTimezone: true }),
    /** Set by the cleanup job for an upload nobody completed. The row stays. */
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
    uploadedBy: uuid('uploaded_by').notNull(),
    /**
     * The professional who owns the document clinically: the one who uploaded it, or who made it
     * clinical by reclassifying it. Required for clinical documents; set once.
     */
    authorProfessionalId: uuid('author_professional_id'),
    replacesDocumentId: uuid('replaces_document_id'),
    /** An earlier document of the same patient with the same content. */
    duplicateOfId: uuid('duplicate_of_id'),
    hiddenAt: timestamp('hidden_at', { withTimezone: true }),
    hiddenBy: uuid('hidden_by'),
    hiddenReason: text('hidden_reason'),
  },
  (table) => [
    foreignKey({
      name: 'document_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'document_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'document_author_professional_fkey',
      columns: [table.tenantId, table.authorProfessionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'document_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    foreignKey({
      name: 'document_encounter_fkey',
      columns: [table.tenantId, table.encounterId],
      foreignColumns: [encounter.tenantId, encounter.id],
    }),
    foreignKey({
      name: 'document_replaces_fkey',
      columns: [table.tenantId, table.replacesDocumentId],
      foreignColumns: [table.tenantId, table.id] as unknown as [AnyPgColumn, AnyPgColumn],
    }),
    foreignKey({
      name: 'document_duplicate_of_fkey',
      columns: [table.tenantId, table.duplicateOfId],
      foreignColumns: [table.tenantId, table.id] as unknown as [AnyPgColumn, AnyPgColumn],
    }),
    check('document_status_check', sql`${table.status} in (${list(DOCUMENT_STATUSES)})`),
    check(
      'document_classification_check',
      sql`${table.classification} in (${list(DOCUMENT_CLASSIFICATIONS)})`,
    ),
    check(
      'document_category_check',
      sql`(${table.classification} = 'clinical' and ${table.category} in (${list(DOCUMENT_CATEGORIES.clinical)}))
        or (${table.classification} = 'administrative' and ${table.category} in (${list(DOCUMENT_CATEGORIES.administrative)}))`,
    ),
    check(
      'document_known_category_check',
      sql`${table.category} in (${list(ALL_DOCUMENT_CATEGORIES)})`,
    ),
    check(
      'document_clinical_author_check',
      sql`${table.classification} <> 'clinical' or ${table.authorProfessionalId} is not null`,
    ),
    check(
      'document_size_check',
      sql`${table.sizeBytes} between 1 and ${sql.raw(String(DOCUMENT_MAX_BYTES))}`,
    ),
    check(
      'document_declared_type_check',
      sql`${table.declaredContentType} in (${list(DOCUMENT_CONTENT_TYPES)})`,
    ),
    check(
      'document_content_type_check',
      sql`${table.contentType} is null or ${table.contentType} in (${list(DOCUMENT_CONTENT_TYPES)})`,
    ),
    check(
      'document_sha256_check',
      sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'document_available_check',
      sql`${table.status} not in ('available', 'hidden') or (${table.sha256} is not null and ${table.contentType} is not null)`,
    ),
    check(
      'document_hidden_check',
      sql`${table.status} <> 'hidden' or (${table.hiddenAt} is not null and ${table.hiddenBy} is not null and ${table.hiddenReason} is not null)`,
    ),
    check(
      'document_rejected_check',
      sql`${table.status} <> 'rejected' or ${table.rejectionReason} is not null`,
    ),
    check(
      'document_rejection_reason_check',
      sql`${table.rejectionReason} is null or ${table.rejectionReason} in (${list(DOCUMENT_REJECTION_REASONS)})`,
    ),
    check('document_scan_attempts_check', sql`${table.scanAttempts} >= 0`),
    check('document_rescan_attempts_check', sql`${table.rescanAttempts} >= 0`),
    index('document_patient_idx').on(table.tenantId, table.patientId, table.createdAt),
    index('document_scan_backlog_idx')
      .on(table.tenantId, table.uploadCompletedAt)
      .where(sql`${table.status} = 'quarantined' and ${table.uploadCompletedAt} is not null`),
    index('document_unfinished_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`${table.uploadCompletedAt} is null and ${table.abandonedAt} is null`),
    index('document_sha256_idx')
      .on(table.tenantId, table.patientId, table.sha256)
      .where(sql`${table.sha256} is not null`),
    // One live replacement per document: a second upload of "the next version" is a conflict.
    uniqueIndex('document_replaces_live_key')
      .on(table.tenantId, table.replacesDocumentId)
      .where(
        sql`${table.replacesDocumentId} is not null and ${table.status} <> 'rejected' and ${table.abandonedAt} is null`,
      ),
  ],
);

export type DocumentRow = typeof document.$inferSelect;
export type NewDocument = typeof document.$inferInsert;

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { patient } from './patients.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

/**
 * Clinical records (clinical-records, design 3.4). Four tables, all CLINICAL: only a health
 * professional's transaction sees any row (`clinicalPolicies`, migration 0060), and the content
 * is encrypted with the tenant's data key, bound to its table, column and row.
 *
 *   encounter ──1:1── clinical_note ──1:n── note_version   (the content at the moment of signing)
 *                                  └──1:n── addendum       (corrections, added by treating staff)
 *
 * Nothing here is ever deleted (`REVOKE DELETE`, plus triggers that also stop the owner). A signed
 * entry cannot change, an addendum and a version are insert-only, and the runtime role has no
 * UPDATE on them at all. The rules are in migration 0061 (triggers).
 */

/** Template names are lower-case identifiers; the list lives in code (the template registry). */
const TEMPLATE_KIND_PATTERN = '^[a-z][a-z_]{0,39}$';
const VISIBILITIES = "('default', 'author_only')";

/**
 * One consultation of one patient by one professional. It exists as soon as the professional
 * opens it, and the insert is what makes the professional a treating one (source 2 of the care
 * relationship, trigger `encounter_care_sync`).
 *
 * `appointment_id` is an extension point: scheduling links an encounter to its appointment, but
 * the `appointment` table does not exist on this branch, so there is no foreign key yet.
 *
 * `visibility` and `template_kind` repeat the ones of the note so the clinical policies can decide
 * on this row alone: the existence of an author-only or psychology encounter is as private as its
 * content. A trigger keeps `visibility` equal to the note's.
 */
export const encounter = tenantTable(
  'encounter',
  {
    patientId: uuid('patient_id').notNull(),
    authorProfessionalId: uuid('author_professional_id').notNull(),
    appointmentId: uuid('appointment_id'),
    templateKind: text('template_kind').notNull(),
    visibility: text('visibility').notNull().default('default'),
  },
  (table) => [
    foreignKey({
      name: 'encounter_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'encounter_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'encounter_author_fkey',
      columns: [table.tenantId, table.authorProfessionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('encounter_visibility_check', sql`${table.visibility} in ${sql.raw(VISIBILITIES)}`),
    check(
      'encounter_template_kind_check',
      sql`${table.templateKind} ~ ${sql.raw(`'${TEMPLATE_KIND_PATTERN}'`)}`,
    ),
    index('encounter_patient_idx').on(table.tenantId, table.patientId, table.createdAt),
    index('encounter_appointment_idx')
      .on(table.tenantId, table.appointmentId)
      .where(sql`${table.appointmentId} is not null`),
  ],
);

/**
 * The note of an encounter: `draft` (a single working copy guarded by `draft_revision`),
 * `signed` (immutable) or `entered_in_error` (kept, hidden from the default timeline).
 *
 * While a draft, the content lives encrypted in `draft_content_enc`. Signing writes it to
 * `note_version` and clears the working copy, so the signed text exists exactly once.
 */
export const clinicalNote = tenantTable(
  'clinical_note',
  {
    encounterId: uuid('encounter_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    authorProfessionalId: uuid('author_professional_id').notNull(),
    status: text('status').notNull().default('draft'),
    visibility: text('visibility').notNull().default('default'),
    templateKind: text('template_kind').notNull(),
    templateVersion: integer('template_version').notNull(),
    /** Bumped on every save of the draft; a save based on an older value is refused (409). */
    draftRevision: integer('draft_revision').notNull().default(0),
    draftContentEnc: bytea('draft_content_enc'),
    /** Set by the database when the author signs; the signer is always the author. */
    signedAt: timestamp('signed_at', { withTimezone: true }),
    errorReason: text('error_reason'),
    /** The professional who marked the entry in error (the author or another treating one). */
    errorMarkedBy: uuid('error_marked_by'),
    errorMarkedAt: timestamp('error_marked_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'clinical_note_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'clinical_note_encounter_fkey',
      columns: [table.tenantId, table.encounterId],
      foreignColumns: [encounter.tenantId, encounter.id],
    }),
    foreignKey({
      name: 'clinical_note_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'clinical_note_author_fkey',
      columns: [table.tenantId, table.authorProfessionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    uniqueIndex('clinical_note_encounter_key').on(table.tenantId, table.encounterId),
    check(
      'clinical_note_status_check',
      sql`${table.status} in ('draft', 'signed', 'entered_in_error')`,
    ),
    check('clinical_note_visibility_check', sql`${table.visibility} in ${sql.raw(VISIBILITIES)}`),
    check(
      'clinical_note_template_kind_check',
      sql`${table.templateKind} ~ ${sql.raw(`'${TEMPLATE_KIND_PATTERN}'`)}`,
    ),
    check('clinical_note_template_version_check', sql`${table.templateVersion} >= 1`),
    check('clinical_note_draft_revision_check', sql`${table.draftRevision} >= 0`),
    // The shape of each status, so a row cannot be half signed or half in error.
    check(
      'clinical_note_state_check',
      sql`(
        (${table.status} = 'draft'
          and ${table.signedAt} is null
          and ${table.errorReason} is null and ${table.errorMarkedBy} is null
          and ${table.errorMarkedAt} is null)
        or (${table.status} = 'signed'
          and ${table.signedAt} is not null
          and ${table.draftContentEnc} is null
          and ${table.errorReason} is null and ${table.errorMarkedBy} is null
          and ${table.errorMarkedAt} is null)
        or (${table.status} = 'entered_in_error'
          and length(btrim(${table.errorReason})) between 1 and 500
          and ${table.errorMarkedBy} is not null and ${table.errorMarkedAt} is not null)
      )`,
    ),
    index('clinical_note_patient_idx').on(table.tenantId, table.patientId, table.createdAt),
    index('clinical_note_author_drafts_idx')
      .on(table.tenantId, table.authorProfessionalId, table.updatedAt)
      .where(sql`${table.status} = 'draft'`),
  ],
);

/**
 * The content at the moment of signing, immutable. `content_hash` is the SHA-256 of the canonical
 * plaintext JSON, so anyone who can read the entry can check it was not altered. A note has one
 * version in v1 (corrections are addenda); the table allows more for later template migrations.
 */
export const noteVersion = tenantTable(
  'note_version',
  {
    noteId: uuid('note_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    authorProfessionalId: uuid('author_professional_id').notNull(),
    visibility: text('visibility').notNull(),
    templateKind: text('template_kind').notNull(),
    templateVersion: integer('template_version').notNull(),
    versionNo: integer('version_no').notNull(),
    contentEnc: bytea('content_enc').notNull(),
    contentHash: text('content_hash').notNull(),
    /** The author signs, so the signer is `author_professional_id`; this is the server time. */
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'note_version_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'note_version_note_fkey',
      columns: [table.tenantId, table.noteId],
      foreignColumns: [clinicalNote.tenantId, clinicalNote.id],
    }),
    foreignKey({
      name: 'note_version_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'note_version_author_fkey',
      columns: [table.tenantId, table.authorProfessionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    unique('note_version_tenant_id_note_id_version_no_key').on(
      table.tenantId,
      table.noteId,
      table.versionNo,
    ),
    check('note_version_visibility_check', sql`${table.visibility} in ${sql.raw(VISIBILITIES)}`),
    check('note_version_version_no_check', sql`${table.versionNo} >= 1`),
    check('note_version_template_version_check', sql`${table.templateVersion} >= 1`),
    check('note_version_hash_check', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    index('note_version_patient_idx').on(table.tenantId, table.patientId),
  ],
);

export const ADDENDUM_KINDS = ['correction', 'rectification'] as const;
export type AddendumKind = (typeof ADDENDUM_KINDS)[number];

/**
 * An addition to a signed note, with its own author, server time and a mandatory reason. Insert
 * only: a correction to an addendum is a further addendum. `rectification` is the patient's right
 * to correct their record (Ley 26.529) and the one kind allowed while the organization is
 * read-only (D16).
 */
export const addendum = tenantTable(
  'addendum',
  {
    noteId: uuid('note_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    authorProfessionalId: uuid('author_professional_id').notNull(),
    /** The visibility and template of the note, so the clinical policies decide on this row alone. */
    visibility: text('visibility').notNull(),
    templateKind: text('template_kind').notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    contentEnc: bytea('content_enc').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'addendum_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'addendum_note_fkey',
      columns: [table.tenantId, table.noteId],
      foreignColumns: [clinicalNote.tenantId, clinicalNote.id],
    }),
    foreignKey({
      name: 'addendum_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'addendum_author_fkey',
      columns: [table.tenantId, table.authorProfessionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('addendum_visibility_check', sql`${table.visibility} in ${sql.raw(VISIBILITIES)}`),
    check('addendum_kind_check', sql`${table.kind} in ('correction', 'rectification')`),
    check('addendum_reason_check', sql`length(btrim(${table.reason})) between 1 and 500`),
    index('addendum_note_idx').on(table.tenantId, table.noteId, table.createdAt),
    index('addendum_patient_idx').on(table.tenantId, table.patientId),
  ],
);

export type EncounterRow = typeof encounter.$inferSelect;
export type ClinicalNoteRow = typeof clinicalNote.$inferSelect;
export type NoteVersionRow = typeof noteVersion.$inferSelect;
export type AddendumRow = typeof addendum.$inferSelect;

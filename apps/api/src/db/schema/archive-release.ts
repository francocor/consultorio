import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenant } from './tenant.js';

/**
 * A request to release archived records (tenancy, "Tenant cancellation export": records in the custody
 * of the platform are released only to the patient themselves or to a verified professional, with an
 * audit entry, and the platform operator cannot read the content). This is the break-glass workflow:
 *
 * 1. an operator RECORDS the request (who asks, for what, where the link must go);
 * 2. an operator verifies the identity of the requester OUT OF BAND and ticks the checklist;
 * 3. a DIFFERENT operator approves it (two people: the database refuses the same one twice);
 * 4. the releaser, and only it, decrypts the scope, builds the package and emails a single-use link to
 *    the requester's address, and tells the former contact of the organization.
 *
 * It is a PLATFORM table: the request belongs to no organization's data, it has no `tenant_id`, and it
 * holds the identity of the requester and nothing of the records (`target_tenant_id` says whose archive
 * is asked about). The operator writes steps 1 to 3 and reads the table; the runtime role (the
 * releaser) reads the requests of the organization of its transaction and writes step 4; a status moves
 * only along the allowed steps and only by the role that owns each one (a trigger, migration 0654).
 */
export const archiveReleaseRequest = pgTable(
  'archive_release_request',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    targetTenantId: uuid('target_tenant_id').notNull(),
    /** `patient` asks for their own records, `professional` for the records of their patients. */
    requesterKind: text('requester_kind').notNull(),
    requesterName: text('requester_name').notNull(),
    /** The verified address the link is sent to: nowhere else. */
    requesterEmail: text('requester_email').notNull(),
    /** Patient: the document that finds them in the archive. */
    scopeDocumentType: text('scope_document_type'),
    scopeDocument: text('scope_document'),
    /** Professional: the registration that finds them in the archive. */
    scopeMatriculaJurisdiction: text('scope_matricula_jurisdiction'),
    scopeMatricula: text('scope_matricula'),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('requested'),
    identityChecklist: jsonb('identity_checklist')
      .$type<Record<string, boolean>>()
      .notNull()
      .default({}),
    recordedBy: uuid('recorded_by').notNull(),
    identityVerifiedBy: uuid('identity_verified_by'),
    identityVerifiedAt: timestamp('identity_verified_at', { withTimezone: true }),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** The end of the window to carry out an approved request. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by'),
    rejectedReason: text('rejected_reason'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    /** The package in the organization's bucket until it is downloaded or its link expires. */
    packageKey: text('package_key'),
    packageSha256: text('package_sha256'),
    packageBytes: bigint('package_bytes', { mode: 'number' }),
    linkExpiresAt: timestamp('link_expires_at', { withTimezone: true }),
    downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
    /** When the package was taken out of the bucket: after the download, or when the link expired. */
    packageRemovedAt: timestamp('package_removed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
  },
  (table) => [
    foreignKey({
      name: 'archive_release_request_tenant_fkey',
      columns: [table.targetTenantId],
      foreignColumns: [tenant.id],
    }),
    check(
      'archive_release_request_kind_check',
      sql`${table.requesterKind} in ('patient', 'professional')`,
    ),
    check(
      'archive_release_request_status_check',
      sql`${table.status} in ('requested', 'identity_verified', 'approved', 'released', 'rejected', 'expired', 'failed')`,
    ),
    // A patient is found by their document, a professional by their registration: one or the other.
    check(
      'archive_release_request_scope_check',
      sql`(${table.requesterKind} = 'patient' and ${table.scopeDocumentType} is not null and ${table.scopeDocument} is not null and ${table.scopeMatriculaJurisdiction} is null and ${table.scopeMatricula} is null)
        or (${table.requesterKind} = 'professional' and ${table.scopeMatriculaJurisdiction} is not null and ${table.scopeMatricula} is not null and ${table.scopeDocumentType} is null and ${table.scopeDocument} is null)`,
    ),
    check(
      'archive_release_request_text_check',
      sql`length(${table.requesterName}) between 2 and 120 and length(${table.requesterEmail}) between 3 and 254 and length(${table.reason}) between 5 and 500`,
    ),
    // Two people: the one who verified the identity is never the one who approves.
    check(
      'archive_release_request_four_eyes_check',
      sql`${table.approvedBy} is null or ${table.identityVerifiedBy} is null or ${table.approvedBy} <> ${table.identityVerifiedBy}`,
    ),
    // Approved (and released) means both steps were taken, by someone each, with the checklist complete.
    check(
      'archive_release_request_approved_check',
      sql`${table.status} not in ('approved', 'released') or (${table.identityVerifiedBy} is not null and ${table.identityVerifiedAt} is not null and ${table.approvedBy} is not null and ${table.approvedAt} is not null and ${table.expiresAt} is not null)`,
    ),
    check(
      'archive_release_request_checklist_check',
      sql`${table.identityVerifiedBy} is null or ${table.identityChecklist} @> '{"documentChecked": true, "photoMatches": true, "contactConfirmed": true, "entitlementChecked": true}'::jsonb`,
    ),
    check(
      'archive_release_request_released_check',
      sql`(${table.status} = 'released') = (${table.releasedAt} is not null and ${table.packageKey} is not null and ${table.linkExpiresAt} is not null)`,
    ),
    check(
      'archive_release_request_failed_check',
      sql`(${table.status} = 'failed') = (${table.failureCode} is not null)`,
    ),
    check(
      'archive_release_request_rejected_check',
      sql`(${table.status} = 'rejected') = (${table.rejectedBy} is not null and ${table.rejectedReason} is not null)`,
    ),
    index('archive_release_request_status_idx').on(table.status, table.createdAt),
    index('archive_release_request_tenant_idx').on(table.targetTenantId, table.createdAt),
  ],
);

export type ArchiveReleaseRequestRow = typeof archiveReleaseRequest.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

/**
 * A package of the cancellation export (tenancy, "Tenant cancellation export", Stage 6): the
 * administrative one for the owner, and one clinical package per professional with the records of
 * their own patients. A row is the request (`queued`, written when the organization is cancelled),
 * then the finished package (`ready`, with the object the job stored in the organization's bucket),
 * or the reason it could not be made (`failed`).
 *
 * Who may download a package is decided by `kind` and `professional_id`, never by the row's author:
 * the administrative package belongs to the owner role (`billing.manage`), a clinical one belongs to
 * the professional it was made for and to nobody else. The table holds no clinical content, only the
 * name, size and checksum of a file. Packages are never deleted (nothing hard-deletes tenant data).
 */
export const exportPackage = tenantTable(
  'export_package',
  {
    /** `administrative` for the owner, `clinical` for one professional. */
    kind: text('kind').notNull(),
    /** The professional a clinical package is made for; null for the administrative one. */
    professionalId: uuid('professional_id'),
    status: text('status').notNull().default('queued'),
    /** The object in the organization's bucket (`t/{tenantId}/cancellation-export/...`). */
    objectKey: text('object_key'),
    /** The name the download carries: made by the job from the kind and the day, never typed. */
    fileName: text('file_name'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /** Hex SHA-256 of the file, so a download can be checked against what the job wrote. */
    sha256: text('sha256'),
    /** Files in the zip (JSON sections, attachments and the PDF). */
    entryCount: integer('entry_count'),
    builtAt: timestamp('built_at', { withTimezone: true }),
    /**
     * When the object was taken out of the bucket: after the download window and once the archive that
     * replaces it was verified (JD-S6 R1-A-W7). The row stays, as a record that there was a package.
     */
    objectRemovedAt: timestamp('object_removed_at', { withTimezone: true }),
    /** Why a package could not be made. A code, never a message that could carry data. */
    failureCode: text('failure_code'),
  },
  (table) => [
    foreignKey({
      name: 'export_package_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'export_package_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('export_package_kind_check', sql`${table.kind} in ('administrative', 'clinical')`),
    check('export_package_status_check', sql`${table.status} in ('queued', 'ready', 'failed')`),
    // A clinical package is for one professional; the administrative one is for nobody in particular.
    check(
      'export_package_professional_check',
      sql`(${table.kind} = 'clinical') = (${table.professionalId} is not null)`,
    ),
    // A package that is ready says where it is; one that is not has no file.
    check(
      'export_package_ready_check',
      sql`(${table.status} = 'ready') = (${table.objectKey} is not null and ${table.fileName} is not null and ${table.sizeBytes} is not null and ${table.sha256} is not null and ${table.builtAt} is not null)`,
    ),
    check(
      'export_package_failed_check',
      sql`(${table.status} = 'failed') = (${table.failureCode} is not null)`,
    ),
    // One administrative package per organization and one clinical package per professional: asking
    // again (a retried cancellation) finds the same row instead of making another.
    uniqueIndex('export_package_administrative_key')
      .on(table.tenantId)
      .where(sql`${table.kind} = 'administrative'`),
    uniqueIndex('export_package_clinical_key')
      .on(table.tenantId, table.professionalId)
      .where(sql`${table.kind} = 'clinical'`),
    index('export_package_queued_idx')
      .on(table.tenantId)
      .where(sql`${table.status} = 'queued'`),
  ],
);

export type ExportPackageRow = typeof exportPackage.$inferSelect;

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

/**
 * The archive key pair of an organization (tenancy, "Retention archive after cancellation"): an
 * RSA-OAEP pair per organization. The PUBLIC key encrypts a fresh data key for every archived
 * object, so the API and the worker can write the archive and cannot read it. The PRIVATE key never
 * sits here in the clear: it is wrapped for the releaser process (a sealed box to a key only that
 * process holds, `ARCHIVE_RELEASER_KEK`), so the row alone opens nothing, not even for the database
 * administrator. A version never changes (a rotation adds a version); keys are never deleted.
 */
export const archiveKey = tenantTable(
  'archive_key',
  {
    version: integer('version').notNull(),
    algorithm: text('algorithm').notNull().default('rsa-oaep-3072-sha256'),
    /** SPKI DER of the public key. */
    publicKey: bytea('public_key').notNull(),
    /** Hex SHA-256 of `public_key`: the releaser checks it against what it unwrapped. */
    publicKeySha256: text('public_key_sha256').notNull(),
    /** The private key (PKCS#8 DER) sealed to the releaser. Opaque without `ARCHIVE_RELEASER_KEK`. */
    wrappedPrivateKey: bytea('wrapped_private_key').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'archive_key_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    unique('archive_key_tenant_id_version_key').on(table.tenantId, table.version),
    check('archive_key_version_check', sql`${table.version} >= 1`),
    check('archive_key_algorithm_check', sql`${table.algorithm} = 'rsa-oaep-3072-sha256'`),
  ],
);

export type ArchiveKeyRow = typeof archiveKey.$inferSelect;

/**
 * Where the archive of an organization stands (tenancy, "Retention archive after cancellation"): one
 * row per organization, written when the archive job starts (`pending`, with the id that prefixes
 * every object it stores, so a retry writes the same names) and closed when the manifest is stored
 * (`written`, with the instant that is the organization's `archived_at`). The last verification is
 * recorded here too. The hot rows of the organization are never removed: this row says that a custody
 * copy exists, not that anything else is gone. It holds counts and hashes, never content.
 */
export const tenantArchive = tenantTable(
  'tenant_archive',
  {
    /** The folder of the archive in the bucket: `tenants/{tenant}/{archive}/...`. */
    archiveId: uuid('archive_id').notNull(),
    status: text('status').notNull().default('pending'),
    keyVersion: integer('key_version').notNull(),
    manifestKey: text('manifest_key'),
    manifestSha256: text('manifest_sha256'),
    objectsCount: integer('objects_count'),
    bytesTotal: bigint('bytes_total', { mode: 'number' }),
    /** The end of the retention every object of this archive was written with. */
    retainUntil: timestamp('retain_until', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifyStatus: text('verify_status'),
    verifyProblems: integer('verify_problems'),
    failureCode: text('failure_code'),
    /**
     * The folders of the archive that a legal erasure removed (`tenants/{tenant}/...`). Written only by
     * the erasure command, through `app.archive_mark_erased`: the runtime roles have no UPDATE on it.
     * Verification skips what is under one of them, and a release of it answers `erased`.
     */
    erasedPrefixes: text('erased_prefixes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** When the WHOLE archive was erased; null while any of it remains. */
    erasedAt: timestamp('erased_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'tenant_archive_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    // An organization is archived once.
    uniqueIndex('tenant_archive_tenant_key').on(table.tenantId),
    check('tenant_archive_status_check', sql`${table.status} in ('pending', 'written', 'failed')`),
    check(
      'tenant_archive_written_check',
      sql`(${table.status} = 'written') = (${table.manifestKey} is not null and ${table.manifestSha256} is not null and ${table.objectsCount} is not null and ${table.bytesTotal} is not null and ${table.retainUntil} is not null and ${table.archivedAt} is not null)`,
    ),
    check(
      'tenant_archive_verify_check',
      sql`${table.verifyStatus} is null or ${table.verifyStatus} in ('ok', 'corrupted', 'missing', 'overwritten')`,
    ),
    check(
      'tenant_archive_failed_check',
      sql`(${table.status} = 'failed') = (${table.failureCode} is not null)`,
    ),
    check(
      'tenant_archive_erased_check',
      sql`${table.erasedAt} is null or cardinality(${table.erasedPrefixes}) >= 1`,
    ),
  ],
);

export type TenantArchiveRow = typeof tenantArchive.$inferSelect;

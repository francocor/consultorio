import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

/**
 * The per-tenant data key (DEK) that encrypts that tenant's sensitive fields. Only the DEK
 * WRAPPED by the key service (KMS in production) is stored, never the key itself, so a database
 * dump cannot read the encrypted fields. A tenant has one `active` key per purpose; older
 * versions stay as `retired` so data written under them can still be read after a rotation.
 *
 * The runtime role cannot DELETE a key: losing it would destroy the data it protects.
 */
export const tenantKey = tenantTable(
  'tenant_key',
  {
    purpose: text('purpose').notNull().default('tenant-dek'),
    version: integer('version').notNull(),
    /** Which KEK wrapped it (`local-v1`, or the KMS key id), for re-wrapping on KEK rotation. */
    kekId: text('kek_id').notNull(),
    dekWrapped: bytea('dek_wrapped').notNull(),
    status: text('status').notNull().default('active'),
  },
  (table) => [
    foreignKey({
      name: 'tenant_key_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    unique('tenant_key_tenant_id_purpose_version_key').on(
      table.tenantId,
      table.purpose,
      table.version,
    ),
    // At most one active key per tenant and purpose: makes creation idempotent and race-free.
    uniqueIndex('tenant_key_one_active_idx')
      .on(table.tenantId, table.purpose)
      .where(sql`${table.status} = 'active'`),
    check('tenant_key_status_check', sql`${table.status} in ('active', 'retired')`),
    // The version is stored in two bytes of every ciphertext header.
    check('tenant_key_version_check', sql`${table.version} between 1 and 65535`),
  ],
);

export type TenantKeyRow = typeof tenantKey.$inferSelect;

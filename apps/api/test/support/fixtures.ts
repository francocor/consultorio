import { sql } from 'drizzle-orm';

import type { Tx } from '../../src/platform/db/tenant-context.js';

/**
 * One fixture per tenant table. The generated isolation suite uses it to put a row into a table
 * without knowing the table: a table with no fixture here FAILS the suite, so adding a tenant
 * table forces whoever adds it to say how to create a valid row.
 */
export interface TenantTableFixture {
  /**
   * Inserts one row owned by `tenantId` and returns its id. The caller has already set the tenant
   * context, which may differ from `tenantId` (that is how cross-tenant writes are tested).
   * `overrides` replaces foreign key columns, keyed by column name, with ids of another tenant.
   */
  insert(tx: Tx, tenantId: string, overrides?: Readonly<Record<string, string>>): Promise<string>;
}

async function returningId(tx: Tx, statement: ReturnType<typeof sql>): Promise<string> {
  const result = await tx.execute<{ id: string }>(statement);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('fixture insert returned no id');
  return id;
}

let counter = 0;
/** Unique suffix so repeated fixtures never collide on a unique business key. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

export const TENANT_FIXTURES: Record<string, TenantTableFixture> = {
  audit_event: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO audit_event (tenant_id, action, outcome)
              VALUES (${tenantId}, 'access.denied', 'deny')
              RETURNING id`,
      ),
  },
  location: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO location (tenant_id, name, time_zone)
              VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
              RETURNING id`,
      ),
  },
  tenant_feature: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO tenant_feature (tenant_id, feature, enabled)
              VALUES (${tenantId}, ${unique('feature')}, true)
              RETURNING id`,
      ),
  },
};

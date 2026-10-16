import { sql } from 'drizzle-orm';

import { tenant } from '../../db/schema/tenant.js';
import type { Db } from '../db/pool.js';

/** A tenant id that matches no row, so the tenant_isolation policy evaluates without erroring. */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * Lists every tenant id, for work that fans out across tenants (sealing, nightly verification).
 *
 * It declares the `platform` scope for one transaction, which the `tenant_platform_scan` policy
 * accepts for reading the `tenant` table only. Each tenant's own data is then reached through its
 * own `withTenant` context, never through this scope.
 */
export function listTenantIds(db: Db): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_id', ${NO_TENANT}, true),
      set_config('app.scope', 'platform', true)`);
    const rows = await tx.select({ id: tenant.id }).from(tenant).orderBy(tenant.id);
    return rows.map((row) => row.id);
  });
}

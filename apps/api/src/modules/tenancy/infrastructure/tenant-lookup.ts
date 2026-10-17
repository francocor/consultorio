import { sql } from 'drizzle-orm';

import { tenant } from '../../../db/schema/tenant.js';
import type { Db } from '../../../platform/db/pool.js';
import type { ResolvedTenant } from '../../../platform/http/tenant-host.js';
import type { LookupTenant } from '../application/resolve-tenant.js';

/** A tenant id that matches no row. Lets the tenant_isolation policy evaluate without erroring. */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

/**
 * Finds a tenant by slug BEFORE a tenant context exists (host resolution happens first).
 *
 * The `tenant` table is isolated by its own id, so the lookup opens a short transaction that sets
 * `app.lookup_slug`; the `tenant_host_lookup` policy (migration 0003) lets that transaction read
 * the one row with that slug and nothing else. The setting is transaction-local, and only the
 * columns the host guard needs are selected.
 */
export function createTenantLookup(db: Db): LookupTenant {
  return (slug) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select
        set_config('app.tenant_id', ${NO_TENANT}, true),
        set_config('app.lookup_slug', ${slug}, true)`);
      const rows = await tx
        .select({
          id: tenant.id,
          slug: tenant.slug,
          status: tenant.status,
          readOnlySince: tenant.readOnlySince,
          isDemo: tenant.isDemo,
          country: tenant.country,
        })
        .from(tenant);
      const row = rows[0];
      if (!row) return null;
      const resolved: ResolvedTenant = {
        ...row,
        status: row.status === 'read_only' || row.status === 'cancelled' ? row.status : 'active',
      };
      return resolved;
    });
}

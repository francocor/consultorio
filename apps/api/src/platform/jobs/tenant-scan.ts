import { ne, sql } from 'drizzle-orm';

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
 *
 * An organization nobody confirmed yet (`unverified`, a signup) is not listed: it has no data and
 * no member, so no job has anything to do there, and a flood of signups must not add work to every
 * tick of every job. Its own cleanup is the purge of signups (`app.signup_purge`).
 */
export function listTenantIds(db: Db): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_id', ${NO_TENANT}, true),
      set_config('app.scope', 'platform', true)`);
    const rows = await tx
      .select({ id: tenant.id })
      .from(tenant)
      .where(ne(tenant.status, 'unverified'))
      .orderBy(tenant.id);
    return rows.map((row) => row.id);
  });
}

/**
 * How many organizations there are in each operational status, the unconfirmed signups included (they
 * are not listed for jobs, but they are part of what the platform holds). Same platform scope as
 * `listTenantIds`: it reads the `tenant` table only, and only counts.
 */
export function tenantStatusCounts(db: Db): Promise<Map<string, number>> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_id', ${NO_TENANT}, true),
      set_config('app.scope', 'platform', true)`);
    const result = await tx.execute<{ status: string; n: number }>(
      sql`select status, count(*)::int as n from tenant group by status`,
    );
    return new Map(result.rows.map((row) => [row.status, row.n]));
  });
}

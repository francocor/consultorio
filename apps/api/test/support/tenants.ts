import { sql } from 'drizzle-orm';

import { tenant, type NewTenant } from '../../src/db/schema/tenant.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';

export const TEST_USER = '0190a000-0000-7000-8000-0000000000f1';

export interface TestTenant {
  id: string;
  slug: string;
}

/**
 * Creates a tenant the way the operator console does: the tenant row is inserted under a context
 * whose tenant id is the new row's own id, which is the only insert the `tenant` policy accepts.
 */
export async function createTestTenant(
  handle: DbHandle,
  overrides: Partial<NewTenant> & { slug: string },
): Promise<TestTenant> {
  const id = overrides.id ?? uuidv7();
  const run = createWithTenant(handle.db);
  await run({ tenantId: id, userId: TEST_USER }, (tx) =>
    tx.insert(tenant).values({ ...overrides, id }),
  );
  return { id, slug: overrides.slug };
}

/** Runs a callback as a tenant on the runtime connection. */
export function asTenant<T>(handle: DbHandle, tenantId: string, fn: (tx: Tx) => Promise<T>) {
  return createWithTenant(handle.db)({ tenantId, userId: TEST_USER }, fn);
}

/** Counts rows of a table visible to a tenant. */
export async function visibleRows(handle: DbHandle, tenantId: string, table: string) {
  const result = await asTenant(handle, tenantId, (tx) =>
    tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`),
  );
  return result.rows[0]?.n ?? -1;
}

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { location } from '../../src/db/schema/tenant.js';
import { createExportRegistry } from '../../src/modules/tenancy/application/export-registry.js';
import { registerTenancyExportContributors } from '../../src/modules/tenancy/index.js';
import { createTenantLookup } from '../../src/modules/tenancy/infrastructure/tenant-lookup.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let norte: TestTenant;
let sur: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  norte = await createTestTenant(runtime, { slug: 'lookup-norte', country: 'AR' });
  sur = await createTestTenant(runtime, { slug: 'lookup-sur', isDemo: true });
  await asTenant(runtime, norte.id, (tx) =>
    tx.insert(location).values({
      tenantId: norte.id,
      name: 'Centro',
      timeZone: 'America/Argentina/Buenos_Aires',
    }),
  );
});

afterAll(async () => {
  await runtime.close();
});

describe('tenant lookup by slug (host resolution)', () => {
  it('finds a tenant before any tenant context exists, with only the fields the guard needs', async () => {
    const lookup = createTenantLookup(runtime.db);

    const found = await lookup('lookup-norte');

    expect(found).toEqual({
      id: norte.id,
      slug: 'lookup-norte',
      status: 'active',
      readOnlySince: null,
      isDemo: false,
      country: 'AR',
    });
  });

  it('reports the demo flag and the read-only state', async () => {
    const lookup = createTenantLookup(runtime.db);
    await asTenant(runtime, sur.id, (tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = '2026-10-01T00:00:00Z' WHERE id = ${sur.id}`,
      ),
    );

    const found = await lookup('lookup-sur');

    expect(found).toMatchObject({ isDemo: true, status: 'read_only' });
    expect(found?.readOnlySince).toEqual(new Date('2026-10-01T00:00:00Z'));
  });

  it('answers null for a slug that does not exist', async () => {
    expect(await createTenantLookup(runtime.db)('lookup-ghost')).toBeNull();
  });

  it('returns one tenant per slug and never leaks a neighbour', async () => {
    const lookup = createTenantLookup(runtime.db);

    const [a, b] = await Promise.all([lookup('lookup-norte'), lookup('lookup-sur')]);

    expect(a?.id).toBe(norte.id);
    expect(b?.id).toBe(sur.id);
  });

  it('does not widen what an ordinary query can see: without the lookup, other tenants stay hidden', async () => {
    const rows = await asTenant(runtime, norte.id, (tx) =>
      tx.execute<{ slug: string }>(sql`SELECT slug FROM tenant ORDER BY slug`),
    );

    expect(rows.rows).toEqual([{ slug: 'lookup-norte' }]);
  });

  it('keeps the lookup permission transaction-local', async () => {
    await createTenantLookup(runtime.db)('lookup-sur');

    await expect(runtime.pool.query('SELECT slug FROM tenant')).rejects.toThrow(
      /unrecognized configuration parameter|invalid input syntax/,
    );
  });
});

describe('tenancy export contributor', () => {
  it('registers an administrative contributor named after the module', () => {
    const registry = createExportRegistry();

    registerTenancyExportContributors(registry);

    expect(registry.list().map((entry) => [entry.kind, entry.name])).toEqual([
      ['administrative', 'tenancy'],
    ]);
  });

  it('exports the organization configuration of the requesting tenant only', async () => {
    const registry = createExportRegistry();
    registerTenancyExportContributors(registry);
    const [contributor] = registry.list('administrative');
    if (!contributor) throw new Error('tenancy contributor missing');

    const part = await asTenant(runtime, norte.id, (tx) =>
      contributor.contribute({ tx, tenantId: norte.id }),
    );

    expect(part).toMatchObject({
      organization: { slug: 'lookup-norte', country: 'AR', status: 'active' },
      locations: [{ name: 'Centro', timeZone: 'America/Argentina/Buenos_Aires', active: true }],
    });
    expect(JSON.stringify(part)).not.toContain('lookup-sur');
  });
});

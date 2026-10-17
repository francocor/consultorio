import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { location, tenant, tenantFeature } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asTenant, createTestTenant, visibleRows, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'centro-a' });
  b = await createTestTenant(runtime, { slug: 'centro-b' });
});

afterAll(async () => {
  await runtime.close();
});

describe('tenant', () => {
  it('starts active, not demo, not exempt, in Argentina, with empty theme and settings', async () => {
    const rows = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(tenant).where(eq(tenant.id, a.id)),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: 'centro-a',
      status: 'active',
      readOnlySince: null,
      isDemo: false,
      billingExempt: false,
      country: 'AR',
      theme: {},
      settings: {},
    });
  });

  it('lets a tenant see only its own tenant row', async () => {
    const seen = await asTenant(runtime, a.id, (tx) =>
      tx.select({ slug: tenant.slug }).from(tenant),
    );

    expect(seen).toEqual([{ slug: 'centro-a' }]);
    expect(await visibleRows(runtime, b.id, 'tenant')).toBe(1);
  });

  it('refuses to create a tenant row under another tenant context', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(tenant).values({ id: '0190a000-0000-7000-8000-0000000000aa', slug: 'intruder' }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it.each(['Centro', 'a', '-centro', 'centro-', 'cen tro', 'x'.repeat(64)])(
    'rejects the slug %j',
    async (slug) => {
      const id = '0190a000-0000-7000-8000-0000000000bb';

      await expect(
        asTenant(runtime, id, (tx) => tx.insert(tenant).values({ id, slug })),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    },
  );

  it('keeps slugs unique across tenants', async () => {
    const id = '0190a000-0000-7000-8000-0000000000cc';

    await expect(
      asTenant(runtime, id, (tx) => tx.insert(tenant).values({ id, slug: 'centro-a' })),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('only accepts the statuses active, read_only and cancelled', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(sql`UPDATE tenant SET status = 'suspended' WHERE id = ${a.id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('requires read_only_since whenever the status is read_only', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(sql`UPDATE tenant SET status = 'read_only' WHERE id = ${a.id}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await asTenant(runtime, a.id, (tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${a.id}`,
      ),
    );
    const [row] = await asTenant(runtime, a.id, (tx) =>
      tx.select({ status: tenant.status }).from(tenant),
    );
    expect(row?.status).toBe('read_only');

    // Back to active after payment: the timestamp is cleared.
    await asTenant(runtime, a.id, (tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'active', read_only_since = NULL WHERE id = ${a.id}`,
      ),
    );
  });
});

describe('tenant.is_demo is immutable', () => {
  it('raises when an update changes is_demo, in either direction', async () => {
    const demo = await createTestTenant(runtime, { slug: 'demo-aillu', isDemo: true });

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.execute(sql`UPDATE tenant SET is_demo = true WHERE id = ${a.id}`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/is_demo/) as unknown } });
    await expect(
      asTenant(runtime, demo.id, (tx) =>
        tx.execute(sql`UPDATE tenant SET is_demo = false WHERE id = ${demo.id}`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/is_demo/) as unknown } });
  });

  it('still allows other updates, including re-saving the same is_demo value', async () => {
    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(tenant)
        .set({ isDemo: false, billingExempt: true, theme: { primary: '#0a7' } })
        .where(eq(tenant.id, a.id)),
    );

    const [row] = await asTenant(runtime, a.id, (tx) => tx.select().from(tenant));
    expect(row).toMatchObject({ isDemo: false, billingExempt: true, theme: { primary: '#0a7' } });
  });
});

describe('location', () => {
  it('belongs to one tenant and carries an IANA time zone', async () => {
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(location).values({
        tenantId: a.id,
        name: 'Centro',
        timeZone: 'America/Argentina/Buenos_Aires',
      }),
    );
    await asTenant(runtime, a.id, (tx) =>
      tx
        .insert(location)
        .values({ tenantId: a.id, name: 'Norte', timeZone: 'America/Argentina/Salta' }),
    );

    const mine = await asTenant(runtime, a.id, (tx) =>
      tx
        .select({ name: location.name, active: location.active })
        .from(location)
        .orderBy(location.name),
    );

    expect(mine).toEqual([
      { name: 'Centro', active: true },
      { name: 'Norte', active: true },
    ]);
    expect(await visibleRows(runtime, b.id, 'location')).toBe(0);
  });

  it.each(['Not A Zone!', '', 'Buenos Aires'])('rejects the time zone %j', async (timeZone) => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(location).values({ tenantId: a.id, name: 'Bad', timeZone }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('is deactivated rather than deleted, and the row stays readable', async () => {
    await asTenant(runtime, a.id, (tx) =>
      tx.update(location).set({ active: false }).where(eq(location.name, 'Norte')),
    );

    const rows = await asTenant(runtime, a.id, (tx) =>
      tx
        .select({ name: location.name, active: location.active })
        .from(location)
        .where(eq(location.name, 'Norte')),
    );
    expect(rows).toEqual([{ name: 'Norte', active: false }]);
  });

  it('cannot point at a tenant that does not exist', async () => {
    const ghost = '0190a000-0000-7000-8000-0000000000dd';

    await expect(
      asTenant(runtime, ghost, (tx) =>
        tx.insert(location).values({ tenantId: ghost, name: 'Ghost', timeZone: 'UTC' }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });
});

describe('tenant_feature', () => {
  it('stores one flag per feature per tenant', async () => {
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(tenantFeature).values({ tenantId: a.id, feature: 'whatsapp', enabled: true }),
    );

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.insert(tenantFeature).values({ tenantId: a.id, feature: 'whatsapp', enabled: false }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    // The same feature name is free for another tenant.
    await asTenant(runtime, b.id, (tx) =>
      tx.insert(tenantFeature).values({ tenantId: b.id, feature: 'whatsapp', enabled: false }),
    );
    expect(await visibleRows(runtime, a.id, 'tenant_feature')).toBe(1);
    expect(await visibleRows(runtime, b.id, 'tenant_feature')).toBe(1);
  });
});

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { tenantPolicies } from '../../src/db/schema/_helpers.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { TENANT_FIXTURES, type TenantTableFixture } from '../support/fixtures.js';
import {
  findTablesWithoutFixture,
  fixtureFor,
  insertAcrossTenants,
  listCompositeTenantForeignKeys,
  listTenantTables,
  rowsVisibleTo,
} from '../support/isolation.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

/**
 * Generated tenancy isolation suite. The tables are discovered from the catalog, so a new tenant
 * table is covered the moment its migration lands, and a table with no registered fixture fails
 * the suite instead of silently escaping it.
 */

const catalog = new pg.Client({ connectionString: inject('ownerUrl') });
await catalog.connect();
const TABLES = await listTenantTables(catalog);
const COMPOSITE_FKS = await listCompositeTenantForeignKeys(catalog);
await catalog.end();

let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'isolation-a' });
  b = await createTestTenant(runtime, { slug: 'isolation-b' });
});

afterAll(async () => {
  await runtime.close();
  await owner.end();
});

describe('tenant isolation, generated from the catalog', () => {
  it('discovers the tenant tables (the generator is not silently empty)', () => {
    expect(TABLES).toEqual(expect.arrayContaining(['location', 'tenant_feature']));
  });

  it('has a registered fixture for every tenant table', () => {
    expect(findTablesWithoutFixture(TABLES, TENANT_FIXTURES)).toEqual([]);
  });

  it('isolates the tenant table itself: B cannot see the row of A', async () => {
    expect(await rowsVisibleTo(runtime, a.id, 'tenant', a.id)).toBe(1);
    expect(await rowsVisibleTo(runtime, b.id, 'tenant', a.id)).toBe(0);
  });

  describe.each(TABLES)('%s', (table) => {
    it('lets tenant A read its row and gives tenant B 0 rows of tenant A', async () => {
      const fixture = fixtureFor(table, TENANT_FIXTURES);
      const id = await asTenant(runtime, a.id, (tx) => fixture.insert(tx, a.id));

      expect(await rowsVisibleTo(runtime, a.id, table, id)).toBe(1);
      expect(await rowsVisibleTo(runtime, b.id, table, id)).toBe(0);
      expect(await rowsVisibleTo(runtime, b.id, table)).toBe(0);
    });

    it('stops tenant B from inserting a row that belongs to tenant A', async () => {
      const fixture = fixtureFor(table, TENANT_FIXTURES);

      await expect(asTenant(runtime, b.id, (tx) => fixture.insert(tx, a.id))).rejects.toMatchObject(
        { cause: { code: '42501' } },
      );
    });

    it('stops tenant B from updating or moving a row of tenant A', async () => {
      const fixture = fixtureFor(table, TENANT_FIXTURES);
      const id = await asTenant(runtime, a.id, (tx) => fixture.insert(tx, a.id));

      const touched = await asTenant(runtime, b.id, (tx) =>
        tx.execute(sql`UPDATE ${sql.identifier(table)} SET tenant_id = ${b.id} WHERE id = ${id}`),
      );

      expect(touched.rowCount).toBe(0);
      expect(await rowsVisibleTo(runtime, a.id, table, id)).toBe(1);
    });
  });

  describe.each(COMPOSITE_FKS)('composite foreign key $constraint', (fk) => {
    it('rejects a row that points at a parent row of another tenant', async () => {
      const error = await insertAcrossTenants(runtime, fk, TENANT_FIXTURES, a.id, b.id);

      expect(error).toEqual(expect.objectContaining({ code: '23503' }));
    });
  });
});

describe('the isolation generator proves itself', () => {
  const SCRATCH_PARENT = 'zz_iso_parent';
  const SCRATCH_CHILD = 'zz_iso_child';
  const scratchFixtures: Record<string, TenantTableFixture> = {
    [SCRATCH_PARENT]: {
      insert: async (tx, tenantId) => {
        const result = await tx.execute<{ id: string }>(
          sql`INSERT INTO zz_iso_parent (tenant_id) VALUES (${tenantId}) RETURNING id`,
        );
        return result.rows[0]?.id ?? '';
      },
    },
    [SCRATCH_CHILD]: {
      insert: async (tx, tenantId, overrides) => {
        const result = await tx.execute<{ id: string }>(
          sql`INSERT INTO zz_iso_child (tenant_id, parent_id)
                VALUES (${tenantId}, ${overrides?.['parent_id'] ?? null}) RETURNING id`,
        );
        return result.rows[0]?.id ?? '';
      },
    },
  };

  beforeAll(async () => {
    await owner.query(`
      CREATE TABLE zz_iso_parent (
        id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
        tenant_id uuid NOT NULL REFERENCES tenant (id),
        UNIQUE (tenant_id, id)
      );
      CREATE TABLE zz_iso_child (
        id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
        tenant_id uuid NOT NULL REFERENCES tenant (id),
        parent_id uuid NOT NULL,
        FOREIGN KEY (tenant_id, parent_id) REFERENCES zz_iso_parent (tenant_id, id)
      );
    `);
    for (const statement of tenantPolicies(SCRATCH_PARENT).split('\n--> statement-breakpoint\n')) {
      await owner.query(statement);
    }
    for (const statement of tenantPolicies(SCRATCH_CHILD).split('\n--> statement-breakpoint\n')) {
      await owner.query(statement);
    }
    await owner.query('GRANT SELECT, INSERT, UPDATE ON zz_iso_parent, zz_iso_child TO app_rw');
  });

  afterAll(async () => {
    await owner.query('DROP TABLE IF EXISTS zz_iso_child, zz_iso_parent');
  });

  it('finds a composite tenant foreign key and reports it', async () => {
    const found = (await listCompositeTenantForeignKeys(owner)).filter(
      (fk) => fk.table === SCRATCH_CHILD,
    );

    expect(found).toEqual([
      expect.objectContaining({ columns: ['parent_id'], parent: SCRATCH_PARENT }),
    ]);
  });

  it('rejects a cross-tenant composite foreign key insert with 23503', async () => {
    const [fk] = (await listCompositeTenantForeignKeys(owner)).filter(
      (candidate) => candidate.table === SCRATCH_CHILD,
    );
    if (!fk) throw new Error('scratch foreign key not found');

    const error = await insertAcrossTenants(runtime, fk, scratchFixtures, a.id, b.id);

    expect(error).toEqual(expect.objectContaining({ code: '23503' }));
  });

  it('would notice a foreign key that does NOT include the tenant (the leak it guards against)', async () => {
    // A plain FK on parent_id alone would let tenant B point at tenant A's parent.
    await owner.query(`
      CREATE TABLE zz_iso_weak (
        id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
        tenant_id uuid NOT NULL REFERENCES tenant (id),
        parent_id uuid NOT NULL REFERENCES zz_iso_parent (id)
      );
    `);
    try {
      const weak = (await listCompositeTenantForeignKeys(owner)).filter(
        (fk) => fk.table === 'zz_iso_weak',
      );

      expect(weak).toEqual([]);
    } finally {
      await owner.query('DROP TABLE zz_iso_weak');
    }
  });

  it('reports a tenant table that has no fixture', () => {
    expect(findTablesWithoutFixture(['location', 'brand_new_table'], TENANT_FIXTURES)).toEqual([
      'brand_new_table',
    ]);
    expect(() => fixtureFor('brand_new_table', TENANT_FIXTURES)).toThrow(/no fixture/);
  });
});

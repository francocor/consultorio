import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';

import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';

import { CLINICAL_AUTHORS, CLINICAL_TABLES, type TenantTableFixture } from './fixtures.js';
import { asTenant, TEST_USER } from './tenants.js';

/** Tables of the `public` schema that carry a `tenant_id` column (partitions are skipped). */
export async function listTenantTables(client: pg.ClientBase): Promise<string[]> {
  const result = await client.query<{ table: string }>(
    `SELECT c.relname AS "table"
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname = 'public'
      ORDER BY 1`,
  );
  return result.rows.map((row) => row.table);
}

export interface CompositeTenantForeignKey {
  table: string;
  constraint: string;
  /** The referencing columns other than `tenant_id`, in constraint order. */
  columns: string[];
  parent: string;
}

/**
 * Foreign keys of the form (tenant_id, x_id) -> parent (tenant_id, id): the constraints that stop
 * a row from pointing at another tenant's row.
 */
export async function listCompositeTenantForeignKeys(
  client: pg.ClientBase,
): Promise<CompositeTenantForeignKey[]> {
  const result = await client.query<{
    table: string;
    constraint: string;
    columns: string[];
    parent: string;
  }>(
    `SELECT c.conrelid::regclass::text AS "table",
            c.conname AS "constraint",
            c.confrelid::regclass::text AS parent,
            ARRAY(
              SELECT a.attname::text
                FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
               WHERE a.attname <> 'tenant_id'
               ORDER BY k.ord
            ) AS columns
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'public' AND array_length(c.conkey, 1) > 1
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.conrelid AND a.attname = 'tenant_id' AND a.attnum = ANY (c.conkey)
        )
      ORDER BY 1, 2`,
  );
  return result.rows;
}

/** Tables with no fixture. The suite fails when this is not empty. */
export function findTablesWithoutFixture(
  tables: readonly string[],
  fixtures: Readonly<Record<string, unknown>>,
): string[] {
  return tables.filter((table) => !(table in fixtures));
}

export function fixtureFor(
  table: string,
  fixtures: Readonly<Record<string, TenantTableFixture>>,
): TenantTableFixture {
  const fixture = fixtures[table];
  if (!fixture) {
    throw new Error(
      `Tenant table "${table}" has no fixture. Register one in apps/api/test/support/fixtures.ts.`,
    );
  }
  return fixture;
}

/**
 * Tenant B inserts a row of `fk.table` whose foreign key points at a parent row of tenant A.
 * Returns the error the database raised, or null if the insert (wrongly) succeeded.
 */
export async function insertAcrossTenants(
  runtime: DbHandle,
  fk: CompositeTenantForeignKey,
  fixtures: Readonly<Record<string, TenantTableFixture>>,
  tenantA: string,
  tenantB: string,
): Promise<{ code?: string } | null> {
  const parent = await asTenant(runtime, tenantA, (tx) =>
    fixtureFor(fk.parent, fixtures).insert(tx, tenantA),
  );
  const overrides = Object.fromEntries(fk.columns.map((column) => [column, parent]));
  try {
    await asTenant(runtime, tenantB, (tx) =>
      fixtureFor(fk.table, fixtures).insert(tx, tenantB, overrides),
    );
    return null;
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause ?? {};
  }
}

/** Number of rows of `table` that tenant `viewer` can see, optionally restricted to an id. */
export async function rowsVisibleTo(
  runtime: DbHandle,
  viewer: string,
  table: string,
  id?: string,
): Promise<number> {
  const count = (tx: Tx) =>
    tx.execute<{ n: number }>(
      id === undefined
        ? sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}`
        : sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE id = ${id}`,
    );
  // A clinical table is only readable by a professional: read it as the author of the row.
  const result = CLINICAL_TABLES.has(table)
    ? await createWithTenant(runtime.db)(
        {
          tenantId: viewer,
          userId: TEST_USER,
          actingProfessionalId:
            (id === undefined ? undefined : CLINICAL_AUTHORS.get(id)) ?? randomUUID(),
        },
        count,
      )
    : await asTenant(runtime, viewer, count);
  return result.rows[0]?.n ?? -1;
}

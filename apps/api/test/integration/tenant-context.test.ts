import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createWithTenant } from '../../src/platform/db/tenant-context.js';

const TENANT_A = '0190a000-0000-7000-8000-00000000000a';
const TENANT_B = '0190a000-0000-7000-8000-00000000000b';
const USER = '0190a000-0000-7000-8000-0000000000f1';

let owner: pg.Client;
// A single connection makes "outside the transaction" deterministic: it is always the same session.
let pool: pg.Pool;
const withTenant = () => createWithTenant(drizzle(pool));

beforeAll(async () => {
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  await owner.query(`
    CREATE TABLE tenant_probe (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      label text NOT NULL
    );
    ALTER TABLE tenant_probe ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_probe FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON tenant_probe
      USING (tenant_id = current_setting('app.tenant_id')::uuid);
  `);
  pool = new pg.Pool({ connectionString: inject('runtimeUrl'), max: 1 });

  const run = withTenant();
  await run({ tenantId: TENANT_A, userId: USER }, (tx) =>
    tx.execute(
      sql`INSERT INTO tenant_probe (tenant_id, label) VALUES (${TENANT_A}, 'a-1'), (${TENANT_A}, 'a-2')`,
    ),
  );
  await run({ tenantId: TENANT_B, userId: USER }, (tx) =>
    tx.execute(sql`INSERT INTO tenant_probe (tenant_id, label) VALUES (${TENANT_B}, 'b-1')`),
  );
});

afterAll(async () => {
  await pool.end();
  await owner.query('DROP TABLE tenant_probe');
  await owner.end();
});

describe('withTenant', () => {
  it('shows a tenant only its own rows', async () => {
    const run = withTenant();

    const a = await run({ tenantId: TENANT_A, userId: USER }, (tx) =>
      tx.execute<{ label: string }>(sql`SELECT label FROM tenant_probe ORDER BY label`),
    );
    const b = await run({ tenantId: TENANT_B, userId: USER }, (tx) =>
      tx.execute<{ label: string }>(sql`SELECT label FROM tenant_probe ORDER BY label`),
    );

    expect(a.rows.map((row) => row.label)).toEqual(['a-1', 'a-2']);
    expect(b.rows.map((row) => row.label)).toEqual(['b-1']);
  });

  it('rejects writing a row that belongs to another tenant', async () => {
    const run = withTenant();

    // drizzle-orm wraps driver errors in DrizzleQueryError; the Postgres error is its cause.
    await expect(
      run({ tenantId: TENANT_A, userId: USER }, (tx) =>
        tx.execute(sql`INSERT INTO tenant_probe (tenant_id, label) VALUES (${TENANT_B}, 'leak')`),
      ),
    ).rejects.toMatchObject({
      cause: { code: '42501', message: expect.stringMatching(/row-level security/) as unknown },
    });
  });

  it('fails closed outside withTenant instead of returning rows', async () => {
    // Even on a session that already ran withTenant, the setting is gone after the transaction.
    await withTenant()({ tenantId: TENANT_A, userId: USER }, (tx) => tx.execute(sql`SELECT 1`));

    await expect(pool.query('SELECT * FROM tenant_probe')).rejects.toThrow();
  });

  it('keeps the context transaction-local', async () => {
    await withTenant()({ tenantId: TENANT_A, userId: USER, actingProfessionalId: USER }, (tx) =>
      tx.execute(sql`SELECT 1`),
    );

    const { rows } = await pool.query<{ tenant: string | null; user: string | null }>(
      `SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant,
              nullif(current_setting('app.user_id', true), '') AS "user"`,
    );
    expect(rows[0]).toEqual({ tenant: null, user: null });
  });

  it('sets all three context values inside the transaction', async () => {
    const result = await withTenant()(
      { tenantId: TENANT_A, userId: USER, actingProfessionalId: null },
      (tx) =>
        tx.execute<{ tenant: string; user: string; professional: string }>(
          sql`SELECT current_setting('app.tenant_id') AS tenant,
                     current_setting('app.user_id') AS "user",
                     current_setting('app.professional_id') AS professional`,
        ),
    );

    expect(result.rows[0]).toEqual({ tenant: TENANT_A, user: USER, professional: '' });
  });
});

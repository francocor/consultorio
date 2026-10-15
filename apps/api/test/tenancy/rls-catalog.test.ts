import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { findUnprotectedTenantTables } from '../support/rls-catalog.js';

let owner: pg.Client;

beforeAll(async () => {
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
});

afterAll(async () => {
  await owner.query('DROP SCHEMA IF EXISTS rls_scratch CASCADE');
  await owner.end();
});

describe('RLS catalog', () => {
  it('every tenant table in the application schemas has RLS enabled, forced and a policy', async () => {
    const unprotected = await findUnprotectedTenantTables(owner, ['public']);

    expect(unprotected).toEqual([]);
  });

  it('flags a tenant table that is missing protection (the check proves itself)', async () => {
    await owner.query(`
      CREATE SCHEMA rls_scratch;
      -- No RLS at all.
      CREATE TABLE rls_scratch.bad_none (tenant_id uuid NOT NULL);
      -- Enabled and a policy, but not FORCED: the owner would bypass it.
      CREATE TABLE rls_scratch.bad_unforced (tenant_id uuid NOT NULL);
      ALTER TABLE rls_scratch.bad_unforced ENABLE ROW LEVEL SECURITY;
      CREATE POLICY p ON rls_scratch.bad_unforced USING (true);
      -- Enabled and forced, but no policy: locked, yet unreviewed.
      CREATE TABLE rls_scratch.bad_nopolicy (tenant_id uuid NOT NULL);
      ALTER TABLE rls_scratch.bad_nopolicy ENABLE ROW LEVEL SECURITY;
      ALTER TABLE rls_scratch.bad_nopolicy FORCE ROW LEVEL SECURITY;
      -- Fully protected.
      CREATE TABLE rls_scratch.good (tenant_id uuid NOT NULL);
      ALTER TABLE rls_scratch.good ENABLE ROW LEVEL SECURITY;
      ALTER TABLE rls_scratch.good FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON rls_scratch.good
        USING (tenant_id = current_setting('app.tenant_id')::uuid);
      -- No tenant_id column: out of scope for this check.
      CREATE TABLE rls_scratch.platform_table (id int);
    `);

    const unprotected = await findUnprotectedTenantTables(owner, ['rls_scratch']);

    expect(unprotected.map((row) => row.table).sort()).toEqual([
      'bad_none',
      'bad_nopolicy',
      'bad_unforced',
    ]);
  });
});

import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import { resetDemoTenant } from '../../src/db/seed/demo/reset.js';
import { seedDemoTenant, type DemoSeedDeps } from '../../src/db/seed/demo/seed.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { createTenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { createTestTenant } from '../support/tenants.js';

/**
 * The demo organization has to stay a faithful picture of the product (demo, "Every module has
 * demo data"; "Reset to a known state in under a minute"). These two checks make that a property of
 * the build rather than of somebody's memory.
 */

/** Budget for a full reset in CI. The requirement is 60 seconds; this leaves a safety margin. */
const RESET_BUDGET_MS = 30_000;

/**
 * Tenant tables the demo seed leaves empty ON PURPOSE, each with the reason. A new module adds its
 * tables to the seed or, with a reason, to this list: the test fails until one of the two happens.
 */
const NO_SEED_DATA: Record<string, string> = {
  action_token: 'One-time links are created by people inviting or resetting; none is pending.',
  job_execution: 'Idempotence markers of background jobs; created when a job runs.',
  login_challenge: 'A pending second-factor step; exists for minutes while somebody signs in.',
  patient_rights_request:
    'Created by reception when a patient exercises a right; the demo shows the empty state first.',
  permission_grant:
    'Extra permissions are handed out by an administrator; the demo shows roles alone.',
  session: 'Created when somebody signs in; the reset signs everyone out.',
  slot_hold:
    'A slot kept for a few minutes while somebody books; every hold has expired or become an appointment.',
  support_grant: 'Opened by an organization for the platform operator, for a stated reason.',
};

let runtime: DbHandle;
let owner: pg.Client;
let operator: OperatorHarness;
let deps: DemoSeedDeps;

beforeAll(async () => {
  const ownerDb = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(ownerDb.db);
  await ownerDb.close();
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operator = createOperatorHarness();
  deps = {
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    keys: createTenantKeys({ kms: createLocalKeyManagement(randomBytes(32).toString('base64')) }),
    consentText: { textKey: 'consent.data_processing', version: '1' },
    clock: () => new Date('2026-03-02T12:00:00Z'),
  };
}, 120_000);

afterAll(async () => {
  await operator.close();
  await runtime.close();
  await owner.end();
});

/** Every table that holds an organization's data, except its own configuration rows. */
async function tenantTables(): Promise<string[]> {
  const result = await owner.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition AND n.nspname = 'public'
        AND c.relname NOT IN ('tenant', 'tenant_key', 'tenant_feature')
      ORDER BY 1`,
  );
  return result.rows.map((row) => row.name);
}

describe('the demo organization', () => {
  it('resets in a fraction of the minute the requirement allows', async () => {
    const id = (
      await createTestTenant(runtime, { slug: 'budget', isDemo: true, billingExempt: true })
    ).id;
    await seedDemoTenant(deps, id);

    const started = performance.now();
    await resetDemoTenant({ ...deps, operatorDb: operator.db.db }, id, { operatorId: null });
    const elapsed = performance.now() - started;

    process.stdout.write(`demo reset took ${String(Math.round(elapsed))} ms\n`);
    expect(elapsed).toBeLessThan(RESET_BUDGET_MS);
  }, 120_000);

  it('has data in every module: no tenant table is empty unless it is listed with a reason', async () => {
    const id = (
      await createTestTenant(runtime, { slug: 'coverage', isDemo: true, billingExempt: true })
    ).id;
    await seedDemoTenant(deps, id);

    // The reset reports what it removed per table, which is also exactly what the seed put there.
    const result = await operator.db.db.execute<{ outcome: { deleted: Record<string, number> } }>(
      sql`SELECT app.demo_reset(${id}::uuid) AS outcome`,
    );
    const filled = new Set(Object.keys(result.rows[0]?.outcome.deleted ?? {}));
    const tables = await tenantTables();

    const empty = tables.filter((table) => !filled.has(table));
    const unexplained = empty.filter((table) => NO_SEED_DATA[table] === undefined);
    expect(unexplained, 'tables with no demo data and no reason').toEqual([]);

    // The list cannot rot: a table that now has data, or no longer exists, must leave it.
    const stale = Object.keys(NO_SEED_DATA).filter(
      (table) => filled.has(table) || !tables.includes(table),
    );
    expect(stale, 'listed as empty but not empty (or gone)').toEqual([]);
  }, 120_000);
});

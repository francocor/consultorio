import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createAuditJobs } from '../../src/platform/audit/jobs.js';
import { sealTenant } from '../../src/platform/audit/sealer.js';
import { verifyTenantChain } from '../../src/platform/audit/verify.js';
import { audit, type AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, createSealerDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { createMetrics } from '../../src/platform/metrics.js';
import { asTenant, createTestTenant, TEST_USER, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let sealer: DbHandle;
let owner: pg.Client;

const ACTOR: AuditActor = {
  userId: TEST_USER,
  actingRole: 'admin',
  ip: '203.0.113.30',
  userAgent: 'verify-test',
  requestId: null,
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  sealer = createSealerDb(inject('sealerUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
});

afterAll(async () => {
  await runtime.close();
  await sealer.close();
  await owner.end();
});

/** A tenant whose chain has `count` sealed events. */
async function chainOf(slug: string, count: number): Promise<TestTenant> {
  const tenant = await createTestTenant(runtime, { slug });
  for (let i = 0; i < count; i += 1) {
    await asTenant(runtime, tenant.id, (tx) =>
      audit(tx, {
        action: 'patient.updated',
        outcome: 'allow',
        actor: { ...ACTOR, requestId: `${slug}-${String(i + 1)}` },
        metadata: { n: i + 1 },
      }),
    );
  }
  await asTenant(sealer, tenant.id, (tx) => sealTenant(tx, { graceMs: 0 }));
  return tenant;
}

/**
 * Tampers with storage the way an attacker with the owner credentials would: the append-only
 * trigger is switched off for the statement and back on right after.
 */
async function tamper(
  tenant: TestTenant,
  statement: string,
  values: unknown[] = [],
): Promise<void> {
  await owner.query('BEGIN');
  try {
    await owner.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenant.id]);
    await owner.query('ALTER TABLE audit_event DISABLE TRIGGER audit_event_guard');
    await owner.query(statement, values);
    await owner.query('ALTER TABLE audit_event ENABLE TRIGGER audit_event_guard');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

function verify(tenant: TestTenant, pageSize?: number) {
  return asTenant(runtime, tenant.id, (tx) =>
    verifyTenantChain(tx, pageSize === undefined ? {} : { pageSize }),
  );
}

describe('audit chain verification', () => {
  it('accepts an intact chain', async () => {
    const tenant = await chainOf('verify-ok', 12);

    expect(await verify(tenant)).toEqual({ ok: true, verified: 12 });
  });

  it('accepts an intact chain read in several pages', async () => {
    const tenant = await chainOf('verify-pages', 12);

    expect(await verify(tenant, 5)).toEqual({ ok: true, verified: 12 });
  });

  it('accepts a tenant with no events and ignores unsealed ones', async () => {
    const empty = await createTestTenant(runtime, { slug: 'verify-empty' });
    await asTenant(runtime, empty.id, (tx) =>
      audit(tx, { action: 'auth.logout', outcome: 'allow', actor: ACTOR }),
    );

    expect(await verify(empty)).toEqual({ ok: true, verified: 0 });
  });

  it('reports the first bad sequence when a row is altered in storage', async () => {
    const tenant = await chainOf('verify-altered', 10);

    await tamper(tenant, `UPDATE audit_event SET action = 'auth.logout' WHERE seq = 5`);

    expect(await verify(tenant)).toEqual({
      ok: false,
      firstBadSeq: 5,
      reason: 'hash_mismatch',
      verified: 4,
    });
  });

  it('reports a metadata edit too (the content is part of the hash)', async () => {
    const tenant = await chainOf('verify-meta', 6);

    await tamper(tenant, `UPDATE audit_event SET metadata = '{"n": 999}' WHERE seq = 3`);

    expect(await verify(tenant)).toMatchObject({
      ok: false,
      firstBadSeq: 3,
      reason: 'hash_mismatch',
    });
  });

  it('reports a removed row in the middle as a gap at the missing number', async () => {
    const tenant = await chainOf('verify-gap', 8);

    await tamper(tenant, `DELETE FROM audit_event WHERE seq = 4`);

    expect(await verify(tenant)).toEqual({ ok: false, firstBadSeq: 4, reason: 'gap', verified: 3 });
  });

  it('reports a removed first row', async () => {
    const tenant = await chainOf('verify-first', 5);

    await tamper(tenant, `DELETE FROM audit_event WHERE seq = 1`);

    expect(await verify(tenant)).toMatchObject({ ok: false, firstBadSeq: 1, reason: 'gap' });
  });

  it('reports two rows that swapped places', async () => {
    const tenant = await chainOf('verify-swap', 8);

    await tamper(
      tenant,
      `UPDATE audit_event SET seq = CASE seq WHEN 3 THEN 6 WHEN 6 THEN 3 END WHERE seq IN (3, 6)`,
    );

    expect(await verify(tenant)).toMatchObject({ ok: false, firstBadSeq: 3 });
  });

  it('reports a rewritten hash even when only the hash column is touched', async () => {
    const tenant = await chainOf('verify-hash', 6);

    await tamper(tenant, `UPDATE audit_event SET hash = repeat('f', 64) WHERE seq = 2`);

    expect(await verify(tenant)).toMatchObject({
      ok: false,
      firstBadSeq: 2,
      reason: 'hash_mismatch',
    });
  });

  it('does not let a break in one tenant affect another tenant', async () => {
    const broken = await chainOf('verify-broken', 4);
    const healthy = await chainOf('verify-healthy', 4);

    await tamper(broken, `UPDATE audit_event SET reason = 'x' WHERE seq = 2`);

    expect((await verify(broken)).ok).toBe(false);
    expect(await verify(healthy)).toEqual({ ok: true, verified: 4 });
  });
});

describe('audit.verify job and metrics', () => {
  const base = { name: 'audit.verify', retryCount: 0, enqueuedAt: new Date() };
  const lines: { object: Record<string, unknown>; message: string }[] = [];
  const log = {
    info: () => undefined,
    error: (object: Record<string, unknown>, message: string) => lines.push({ object, message }),
  };

  it('counts no chain break for an intact chain', async () => {
    const tenant = await chainOf('verify-job-ok', 5);
    const metrics = createMetrics();
    const { verify: job } = createAuditJobs({ sealer: createWithTenant(sealer.db), metrics, log });

    const result = await runJob(runtime.db, job, {
      ...base,
      id: '0190a000-0000-7000-8000-00000000bb01',
      data: { tenantId: tenant.id },
    });

    expect(result).toEqual({ status: 'completed' });
    expect(metrics.get('audit_chain_break_total', { tenant: tenant.id })).toBe(0);
    expect(metrics.get('audit_chain_verified_events', { tenant: tenant.id })).toBe(5);
  });

  it('raises the audit_chain_break metric and logs the first bad sequence after tampering', async () => {
    const tenant = await chainOf('verify-job-break', 6);
    await tamper(tenant, `UPDATE audit_event SET action = 'auth.logout' WHERE seq = 4`);
    const metrics = createMetrics();
    const { verify: job } = createAuditJobs({ sealer: createWithTenant(sealer.db), metrics, log });

    const result = await runJob(runtime.db, job, {
      ...base,
      id: '0190a000-0000-7000-8000-00000000bb02',
      data: { tenantId: tenant.id },
    });

    expect(result).toEqual({ status: 'completed' });
    expect(metrics.get('audit_chain_break_total', { tenant: tenant.id })).toBe(1);
    expect(lines).toContainEqual({
      object: { tenant: tenant.id, firstBadSeq: 4, reason: 'hash_mismatch' },
      message: 'audit chain break',
    });
  });

  it('still verifies a read-only tenant (audit_write is on the allowlist)', async () => {
    const tenant = await chainOf('verify-job-frozen', 3);
    await asTenant(runtime, tenant.id, (tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${tenant.id}`,
      ),
    );
    const metrics = createMetrics();
    const { verify: job } = createAuditJobs({ sealer: createWithTenant(sealer.db), metrics, log });

    const result = await runJob(runtime.db, job, {
      ...base,
      id: '0190a000-0000-7000-8000-00000000bb03',
      data: { tenantId: tenant.id },
    });

    expect(result).toEqual({ status: 'completed' });
    expect(metrics.get('audit_chain_verified_events', { tenant: tenant.id })).toBe(3);
  });
});

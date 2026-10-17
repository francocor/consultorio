import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { ensureAuditPartitions } from '../../src/platform/audit/partitions.js';
import { audit, type AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBoss, createJobClient } from '../../src/platform/jobs/boss.js';
import { listTenantIds } from '../../src/platform/jobs/tenant-scan.js';
import { fanOut, startWorker, type Worker } from '../../src/platform/jobs/worker.js';
import { eventually } from '../support/eventually.js';
import { asTenant, createTestTenant, TEST_USER, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;
let worker: Worker | undefined;

const ACTOR: AuditActor = {
  userId: TEST_USER,
  actingRole: 'admin',
  ip: '203.0.113.40',
  userAgent: 'worker-test',
  requestId: null,
};
const errors: unknown[] = [];

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'worker-a' });
  b = await createTestTenant(runtime, { slug: 'worker-b' });
}, 60_000);

afterAll(async () => {
  await worker?.stop();
  await runtime.close();
});

async function sealedCount(tenant: TestTenant): Promise<number> {
  const result = await asTenant(runtime, tenant.id, (tx) =>
    tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_event WHERE seq IS NOT NULL`,
    ),
  );
  return result.rows[0]?.n ?? 0;
}

describe('tenant scan', () => {
  it('lists every tenant id through the platform scope, without a tenant context', async () => {
    const ids = await listTenantIds(runtime.db);

    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('is not a way to read tenant rows outside the scan: the same session sees nothing afterwards', async () => {
    await listTenantIds(runtime.db);

    await expect(runtime.pool.query('SELECT id FROM tenant')).rejects.toThrow();
  });
});

describe('audit partitions upkeep', () => {
  it('can be run at any time without error', async () => {
    await ensureAuditPartitions(runtime.db);
    await ensureAuditPartitions(runtime.db);

    const result = await runtime.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'audit_event'`,
    );
    expect(result.rows[0]?.n).toBeGreaterThanOrEqual(4);
  });
});

describe('fan out', () => {
  it('queues one job per tenant, and only one per throttle window', async () => {
    const boss = createBoss(inject('runtimeUrl'), 'api');
    await boss.start();
    const client = createJobClient(boss);

    const first = await fanOut(runtime.db, client, 'test.echo', { singletonSeconds: 3600 });
    const second = await fanOut(runtime.db, client, 'test.echo', { singletonSeconds: 3600 });
    const jobs = await boss.findJobs<{ tenantId: string }>('test.echo', { queued: true });
    await boss.stop({ graceful: false });

    expect(first).toBeGreaterThanOrEqual(2);
    expect(second).toBe(first);
    const forA = jobs.filter((job) => job.data.tenantId === a.id);
    expect(forA).toHaveLength(1);
  });
});

describe('worker role: sealing end to end', () => {
  it('seals new audit events of every tenant by itself, shortly after they are written', async () => {
    worker = await startWorker({
      databaseUrl: inject('runtimeUrl'),
      sealerDatabaseUrl: inject('sealerUrl'),
      log: { info: () => undefined, error: (o) => errors.push(o) },
      sealIntervalMs: 300,
      sealGraceMs: 100,
      pollingIntervalSeconds: 0.5,
    });

    for (const tenant of [a, b]) {
      for (let i = 0; i < 3; i += 1) {
        await asTenant(runtime, tenant.id, (tx) =>
          audit(tx, { action: 'auth.login.success', outcome: 'allow', actor: ACTOR }),
        );
      }
    }

    try {
      await eventually(async () =>
        (await sealedCount(a)) === 3 && (await sealedCount(b)) === 3 ? true : undefined,
      );
    } catch (error) {
      // Make a timeout self-explanatory: what was sealed, which jobs exist and what failed.
      const probe = createBoss(inject('runtimeUrl'), 'api');
      await probe.start();
      const jobs = await probe.findJobs('audit.seal', { data: { tenantId: a.id } });
      await probe.stop({ graceful: false });
      throw new Error(
        `sealing did not finish: ${JSON.stringify({
          sealedA: await sealedCount(a),
          sealedB: await sealedCount(b),
          errors,
          jobs: jobs.map((job) => ({
            state: job.state,
            retryCount: job.retryCount,
            createdOn: job.createdOn,
            startedOn: job.startedOn,
            output: job.output,
          })),
        })}`,
        { cause: error },
      );
    }
    expect(errors).toEqual([]);
  }, 60_000);
});

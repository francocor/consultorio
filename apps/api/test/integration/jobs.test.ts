import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { location } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { rawClientOf } from '../../src/platform/db/tenant-context.js';
import { JobPayload, createBoss, createJobClient } from '../../src/platform/jobs/boss.js';
import { defineJob, registerJobs, runJob } from '../../src/platform/jobs/define-job.js';
import { eventually } from '../support/eventually.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

const silent = { info: () => undefined, error: () => undefined };

let runtime: DbHandle;
let worker: PgBoss;
let apiBoss: PgBoss;
let client: ReturnType<typeof createJobClient>;
let a: TestTenant;
let frozen: TestTenant;

const Payload = JobPayload.extend({ label: z.string() });
type Payload = z.infer<typeof Payload>;

/** Counts of effects of the test handler, per label. */
const ran: string[] = [];

const echoJob = defineJob<Payload>({
  name: 'test.echo',
  category: 'read',
  payload: Payload,
  handler: ({ payload }) => {
    ran.push(payload.label);
    return Promise.resolve();
  },
});

const writeJob = defineJob<Payload>({
  name: 'test.write',
  category: 'write',
  payload: Payload,
  handler: async ({ tx, tenantId, payload }) => {
    // Runs under the job's tenant context: this insert is subject to row level security.
    await tx.insert(location).values({ tenantId, name: payload.label, timeZone: 'UTC' });
    ran.push(payload.label);
  },
});

const failJob = defineJob<Payload>({
  name: 'test.fail',
  category: 'write',
  payload: Payload,
  handler: async ({ tx, tenantId, payload }) => {
    await tx.insert(location).values({ tenantId, name: payload.label, timeZone: 'UTC' });
    throw new Error('handler failed after writing');
  },
});

const afipJob = defineJob<Payload>({
  name: 'test.afip',
  category: 'afip_submission',
  payload: Payload,
  handler: ({ payload }) => {
    ran.push(payload.label);
    return Promise.resolve();
  },
});

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'jobs-a' });
  frozen = await createTestTenant(runtime, { slug: 'jobs-frozen' });
  await asTenant(runtime, frozen.id, (tx) =>
    tx.execute(
      sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${frozen.id}`,
    ),
  );

  apiBoss = createBoss(inject('runtimeUrl'), 'api');
  await apiBoss.start();
  client = createJobClient(apiBoss);

  worker = createBoss(inject('runtimeUrl'), 'worker');
  await worker.start();
  await registerJobs(
    worker,
    { db: runtime.db, log: silent },
    [echoJob, writeJob, failJob, afipJob],
    {
      pollingIntervalSeconds: 0.5,
    },
  );
}, 60_000);

afterAll(async () => {
  await worker.stop({ graceful: false });
  await apiBoss.stop({ graceful: false });
  await runtime.close();
});

async function stateOf(name: string, id: string): Promise<string | undefined> {
  const [job] = await apiBoss.findJobs(name, { id });
  return job?.state;
}

async function enqueue(tenant: TestTenant, name: string, label: string): Promise<string> {
  const id = await asTenant(runtime, tenant.id, (tx) =>
    client.enqueue(tx, name, { tenantId: tenant.id, label }),
  );
  if (!id) throw new Error('job was not queued');
  return id;
}

describe('the transaction client', () => {
  it('is the very connection the withTenant callback runs on', async () => {
    const same = await asTenant(runtime, a.id, async (tx) => {
      const viaClient = await rawClientOf(tx).query<{ tenant: string }>(
        `select current_setting('app.tenant_id') as tenant`,
      );
      return viaClient.rows[0]?.tenant;
    });

    expect(same).toBe(a.id);
  });
});

describe('enqueue in the caller transaction', () => {
  it('queues the job when the business transaction commits', async () => {
    const id = await asTenant(runtime, a.id, async (tx) => {
      await tx.insert(location).values({ tenantId: a.id, name: 'enqueue-commit', timeZone: 'UTC' });
      return client.enqueue(
        tx,
        'test.echo',
        { tenantId: a.id, label: 'never-polled' },
        { startAfter: 3600 },
      );
    });

    expect(id).toEqual(expect.any(String));
    expect(await stateOf('test.echo', id ?? '')).toBe('created');
  });

  it('never queues the job when the business transaction rolls back', async () => {
    let queuedId: string | null = null;
    await expect(
      asTenant(runtime, a.id, async (tx) => {
        queuedId = await client.enqueue(
          tx,
          'test.echo',
          { tenantId: a.id, label: 'rolled-back' },
          { startAfter: 3600 },
        );
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');

    expect(queuedId).toEqual(expect.any(String));
    expect(await stateOf('test.echo', String(queuedId))).toBeUndefined();
  });

  it('refuses a payload for a different tenant than the transaction', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        client.enqueue(tx, 'test.echo', { tenantId: frozen.id, label: 'wrong-tenant' }),
      ),
    ).rejects.toThrow(/tenant/);
  });

  it('refuses a payload without a tenant id', async () => {
    await expect(
      asTenant(runtime, a.id, (tx) =>
        client.enqueue(tx, 'test.echo', { label: 'no-tenant' } as unknown as JobPayload),
      ),
    ).rejects.toThrow();
  });
});

describe('a job runs under its tenant context', () => {
  it('executes the handler inside withTenant: its write is isolated and committed', async () => {
    const id = await enqueue(a, 'test.write', 'written-by-job');

    expect(
      await eventually(async () =>
        (await stateOf('test.write', id)) === 'completed' ? true : undefined,
      ),
    ).toBe(true);

    const mine = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(location).where(eq(location.name, 'written-by-job')),
    );
    const others = await asTenant(runtime, frozen.id, (tx) =>
      tx.select().from(location).where(eq(location.name, 'written-by-job')),
    );
    expect(mine).toHaveLength(1);
    expect(others).toHaveLength(0);
  });

  it('lets the API process enqueue without ever executing a job', async () => {
    const only = createBoss(inject('runtimeUrl'), 'api');
    await only.start();
    const idleClient = createJobClient(only);
    // No worker is registered on this instance; another worker would pick it up, so use a queue
    // with a start time in the future to observe that this process leaves it alone.
    const id = await asTenant(runtime, a.id, (tx) =>
      idleClient.enqueue(
        tx,
        'test.echo',
        { tenantId: a.id, label: 'api-only' },
        { startAfter: 3600 },
      ),
    );
    await only.stop({ graceful: false });

    expect(await stateOf('test.echo', id ?? '')).toBe('created');
    expect(ran).not.toContain('api-only');
  });
});

describe('read-only tenants', () => {
  it('ends a write job cancelled and never runs its handler', async () => {
    const id = await enqueue(frozen, 'test.write', 'must-not-run');

    await eventually(async () =>
      (await stateOf('test.write', id)) === 'cancelled' ? true : undefined,
    );

    const rows = await asTenant(runtime, frozen.id, (tx) =>
      tx.select().from(location).where(eq(location.name, 'must-not-run')),
    );
    expect(rows).toHaveLength(0);
    expect(ran).not.toContain('must-not-run');
  });

  it('still runs a read-category job for a read-only tenant', async () => {
    const id = await enqueue(frozen, 'test.echo', 'reads-are-fine');

    await eventually(async () =>
      (await stateOf('test.echo', id)) === 'completed' ? true : undefined,
    );

    expect(ran).toContain('reads-are-fine');
  });

  it('runs an AFIP job queued BEFORE the tenant became read-only', async () => {
    const early = await createTestTenant(runtime, { slug: 'jobs-early' });
    const id = await enqueue(early, 'test.afip', 'queued-before');
    await asTenant(runtime, early.id, (tx) =>
      tx.execute(
        sql`UPDATE tenant SET status = 'read_only', read_only_since = now() WHERE id = ${early.id}`,
      ),
    );

    await eventually(async () =>
      (await stateOf('test.afip', id)) === 'completed' ? true : undefined,
    );

    expect(ran).toContain('queued-before');
  });

  it('cancels an AFIP job queued AFTER the tenant became read-only', async () => {
    const id = await enqueue(frozen, 'test.afip', 'queued-after');

    await eventually(async () =>
      (await stateOf('test.afip', id)) === 'cancelled' ? true : undefined,
    );

    expect(ran).not.toContain('queued-after');
  });
});

describe('throughput', () => {
  const backlogJob = defineJob<Payload>({
    name: 'test.backlog',
    category: 'read',
    payload: Payload,
    handler: () => Promise.resolve(),
  });

  it('drains a backlog of jobs quickly with the production polling interval', async () => {
    const backlogWorker = createBoss(inject('runtimeUrl'), 'worker');
    await backlogWorker.start();
    // The default polling interval (2 s) on purpose: fetching one job per interval would take minutes.
    await registerJobs(backlogWorker, { db: runtime.db, log: silent }, [backlogJob]);

    await asTenant(runtime, a.id, async (tx) => {
      for (let i = 0; i < 150; i += 1) {
        await client.enqueue(tx, 'test.backlog', { tenantId: a.id, label: `backlog-${String(i)}` });
      }
    });

    try {
      const completed = await eventually(async () => {
        const jobs = await apiBoss.findJobs('test.backlog', { limit: 1000 });
        const done = jobs.filter((job) => job.state === 'completed').length;
        return done === 150 ? done : undefined;
      }, 30_000);
      expect(completed).toBe(150);
    } finally {
      await backlogWorker.stop({ graceful: false });
    }
  }, 60_000);

  it('does not let a failing job fail its neighbours in the same batch', async () => {
    const errors: Record<string, unknown>[] = [];
    const flaky = defineJob<Payload>({
      name: 'test.flaky',
      category: 'write',
      payload: Payload,
      handler: ({ payload }) => {
        if (payload.label.startsWith('bad')) return Promise.reject(new Error('boom'));
        return Promise.resolve();
      },
    });
    const flakyWorker = createBoss(inject('runtimeUrl'), 'worker');
    await flakyWorker.start();
    await registerJobs(
      flakyWorker,
      { db: runtime.db, log: { info: () => undefined, error: (object) => errors.push(object) } },
      [flaky],
      { pollingIntervalSeconds: 0.5 },
    );
    const ids = await asTenant(runtime, a.id, async (tx) => [
      await client.enqueue(tx, 'test.flaky', { tenantId: a.id, label: 'ok-1' }),
      await client.enqueue(tx, 'test.flaky', { tenantId: a.id, label: 'bad-1' }),
      await client.enqueue(tx, 'test.flaky', { tenantId: a.id, label: 'ok-2' }),
    ]);

    try {
      await eventually(async () => {
        const states = await Promise.all(ids.map((id) => stateOf('test.flaky', id ?? '')));
        return states.every((state) => state !== 'created' && state !== 'active')
          ? states
          : undefined;
      });
      const states = await Promise.all(ids.map((id) => stateOf('test.flaky', id ?? '')));
      expect(states).toEqual(['completed', 'failed', 'completed']);
      expect(errors).toEqual([expect.objectContaining({ job: 'test.flaky', code: 'unknown' })]);
    } finally {
      await flakyWorker.stop({ graceful: false });
    }
  }, 60_000);
});

describe('runJob', () => {
  const base = { name: 'test.write', retryCount: 0, enqueuedAt: new Date() };

  it('records the job id so a redelivery does not run the handler twice', async () => {
    const id = '0190a000-0000-7000-8000-00000000aa01';
    const input = { ...base, id, data: { tenantId: a.id, label: 'once-only' } };

    const first = await runJob(runtime.db, writeJob, input);
    const second = await runJob(runtime.db, writeJob, input);

    expect(first).toEqual({ status: 'completed' });
    expect(second).toEqual({ status: 'duplicate' });
    const rows = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(location).where(eq(location.name, 'once-only')),
    );
    expect(rows).toHaveLength(1);
  });

  it('rolls back the handler writes and the marker when the handler throws, so a retry runs again', async () => {
    const id = '0190a000-0000-7000-8000-00000000aa02';
    const input = {
      ...base,
      name: 'test.fail',
      id,
      data: { tenantId: a.id, label: 'rolled-back-job' },
    };

    await expect(runJob(runtime.db, failJob, input)).rejects.toThrow(
      'handler failed after writing',
    );
    await expect(runJob(runtime.db, failJob, input)).rejects.toThrow(
      'handler failed after writing',
    );

    const rows = await asTenant(runtime, a.id, (tx) =>
      tx.select().from(location).where(eq(location.name, 'rolled-back-job')),
    );
    expect(rows).toHaveLength(0);
  });

  it('cancels a payload that does not match the schema instead of retrying it', async () => {
    const result = await runJob(runtime.db, writeJob, {
      ...base,
      id: '0190a000-0000-7000-8000-00000000aa03',
      data: { tenantId: 'not-a-uuid' },
    });

    expect(result).toEqual({ status: 'cancelled', reason: 'invalid_payload' });
  });

  it('cancels a job whose tenant does not exist', async () => {
    const result = await runJob(runtime.db, writeJob, {
      ...base,
      id: '0190a000-0000-7000-8000-00000000aa04',
      data: { tenantId: '0190a000-0000-7000-8000-00000000ffff', label: 'ghost' },
    });

    expect(result).toEqual({ status: 'cancelled', reason: 'tenant_not_found' });
  });

  it('cancels with the read-only reason for a frozen tenant', async () => {
    const result = await runJob(runtime.db, writeJob, {
      ...base,
      id: '0190a000-0000-7000-8000-00000000aa05',
      data: { tenantId: frozen.id, label: 'frozen-write' },
    });

    expect(result).toEqual({ status: 'cancelled', reason: 'tenant_read_only' });
  });
});

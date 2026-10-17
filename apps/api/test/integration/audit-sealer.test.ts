import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { GENESIS_HASH, hashEvent } from '../../src/platform/audit/canonicalize.js';
import {
  CANONICAL_COLUMNS,
  toCanonical,
  type RawChainRow,
} from '../../src/platform/audit/chain.js';
import { sealTenant } from '../../src/platform/audit/sealer.js';
import { audit, type AuditActor } from '../../src/platform/audit/writer.js';
import { createRuntimeDb, createSealerDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createMetrics } from '../../src/platform/metrics.js';
import { asTenant, createTestTenant, TEST_USER, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
/** The `audit_sealer` login: the only connection that may fill the seal columns. */
let sealer: DbHandle;
let a: TestTenant;
let b: TestTenant;

const ACTOR: AuditActor = {
  userId: TEST_USER,
  actingRole: 'admin',
  ip: '203.0.113.20',
  userAgent: 'sealer-test',
  requestId: null,
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  sealer = createSealerDb(inject('sealerUrl'));
  a = await createTestTenant(runtime, { slug: 'sealer-a' });
  b = await createTestTenant(runtime, { slug: 'sealer-b' });
});

afterAll(async () => {
  await runtime.close();
  await sealer.close();
});

async function record(tenantId: string, label: string): Promise<void> {
  await asTenant(runtime, tenantId, (tx) =>
    audit(tx, {
      action: 'patient.updated',
      outcome: 'allow',
      actor: { ...ACTOR, requestId: label },
      metadata: { label },
    }),
  );
}

async function sealed(tenantId: string) {
  const result = await asTenant(runtime, tenantId, (tx) =>
    tx.execute<RawChainRow>(
      sql`SELECT ${CANONICAL_COLUMNS} FROM audit_event
           WHERE tenant_id = current_setting('app.tenant_id')::uuid AND seq IS NOT NULL
           ORDER BY seq`,
    ),
  );
  return result.rows;
}

async function unsealedCount(tenantId: string): Promise<number> {
  const result = await asTenant(runtime, tenantId, (tx) =>
    tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_event WHERE seq IS NULL AND tenant_id = ${tenantId}`,
    ),
  );
  return result.rows[0]?.n ?? -1;
}

function seal(tenantId: string, options: Parameters<typeof sealTenant>[1] = { graceMs: 0 }) {
  return asTenant(sealer, tenantId, (tx) => sealTenant(tx, options));
}

/** Recomputes the whole chain from the rows and compares every stored value. */
function expectValidChain(rows: RawChainRow[]) {
  let previous = GENESIS_HASH;
  rows.forEach((row, index) => {
    const seq = index + 1;
    expect(Number(row.seqNo)).toBe(seq);
    expect(row.prevHash).toBe(previous);
    const expected = hashEvent(previous, toCanonical(row, seq));
    expect(row.hash).toBe(expected);
    previous = expected;
  });
}

describe('audit sealer', () => {
  it('seals interleaved concurrent inserts into one correct chain, in (occurred_at, id) order', async () => {
    // 24 events from two tenants written concurrently, on different connections.
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        record(i % 2 === 0 ? a.id : b.id, `interleaved-${String(i)}`),
      ),
    );

    const resultA = await seal(a.id);

    expect(resultA).toEqual({ sealed: 12, lastSeq: 12 });
    const rows = await sealed(a.id);
    expect(rows).toHaveLength(12);
    expectValidChain(rows);
    // The sequence follows insertion time, then id.
    const order = rows.map((row) => [row.occurredAtRaw, row.id] as const);
    const sortedOrder = [...order].sort((left, right) =>
      left[0] === right[0] ? (left[1] < right[1] ? -1 : 1) : left[0] < right[0] ? -1 : 1,
    );
    expect(order.map((o) => o[1])).toEqual(sortedOrder.map((o) => o[1]));
  });

  it('keeps tenants independent: the other tenant is untouched, then starts at the genesis hash', async () => {
    expect(await unsealedCount(b.id)).toBe(12);
    expect(await sealed(b.id)).toHaveLength(0);

    await seal(b.id);

    const rows = await sealed(b.id);
    expect(rows).toHaveLength(12);
    expect(rows[0]?.prevHash).toBe(GENESIS_HASH);
    expectValidChain(rows);
  });

  it('is idempotent: running again seals nothing and changes nothing', async () => {
    const before = await sealed(a.id);

    const again = await seal(a.id);

    expect(again).toEqual({ sealed: 0, lastSeq: 12 });
    expect(await sealed(a.id)).toEqual(before);
  });

  it('continues the chain from the last sealed event', async () => {
    await record(a.id, 'later-1');
    await record(a.id, 'later-2');

    const result = await seal(a.id);

    expect(result).toEqual({ sealed: 2, lastSeq: 14 });
    expectValidChain(await sealed(a.id));
  });

  it('seals in batches', async () => {
    const batched = await createTestTenant(runtime, { slug: 'sealer-batch' });
    for (let i = 0; i < 5; i += 1) await record(batched.id, `batch-${String(i)}`);

    const first = await seal(batched.id, { graceMs: 0, batchSize: 3 });
    const second = await seal(batched.id, { graceMs: 0, batchSize: 3 });

    expect(first).toEqual({ sealed: 3, lastSeq: 3 });
    expect(second).toEqual({ sealed: 2, lastSeq: 5 });
    expectValidChain(await sealed(batched.id));
  });

  it('leaves events newer than the grace window for the next run', async () => {
    const graced = await createTestTenant(runtime, { slug: 'sealer-grace' });
    await record(graced.id, 'fresh');

    const tooEarly = await seal(graced.id, { graceMs: 60_000 });
    const afterGrace = await seal(graced.id, { graceMs: 0 });

    expect(tooEarly).toEqual({ sealed: 0, lastSeq: 0 });
    expect(afterGrace).toEqual({ sealed: 1, lastSeq: 1 });
  });

  it('keeps events visible and marked pending while they are unsealed', async () => {
    const pending = await createTestTenant(runtime, { slug: 'sealer-pending' });
    await record(pending.id, 'visible-before-seal');

    const rows = await asTenant(runtime, pending.id, (tx) =>
      tx.execute<{ seq: string | null; hash: string | null }>(
        sql`SELECT seq, hash FROM audit_event WHERE request_id = 'visible-before-seal'`,
      ),
    );

    expect(rows.rows).toEqual([{ seq: null, hash: null }]);
  });

  it('two sealers running at the same time still produce one chain without duplicate numbers', async () => {
    const racing = await createTestTenant(runtime, { slug: 'sealer-race' });
    for (let i = 0; i < 10; i += 1) await record(racing.id, `race-${String(i)}`);

    const results = await Promise.all([seal(racing.id), seal(racing.id)]);

    expect(results.reduce((total, result) => total + result.sealed, 0)).toBe(10);
    const rows = await sealed(racing.id);
    expect(rows).toHaveLength(10);
    expectValidChain(rows);
  });

  it('does not seal an event whose transaction commits late until it is visible, then keeps order', async () => {
    const late = await createTestTenant(runtime, { slug: 'sealer-late' });
    const withTenant = createWithTenant(runtime.db);

    let releaseSlow: () => void = () => undefined;
    const slowStarted = new Promise<void>((started) => {
      void withTenant({ tenantId: late.id, userId: TEST_USER }, async (tx) => {
        await audit(tx, {
          action: 'patient.updated',
          outcome: 'allow',
          actor: { ...ACTOR, requestId: 'slow-first' },
        });
        started();
        await new Promise<void>((release) => {
          releaseSlow = release;
        });
      });
    });
    await slowStarted;
    await record(late.id, 'fast-second');

    // The slow transaction's row is invisible, so only the fast one could be sealed...
    const duringSlow = await seal(late.id, { graceMs: 5_000 });
    expect(duringSlow).toEqual({ sealed: 0, lastSeq: 0 });

    // ...and the grace window keeps it unsealed until the slow one has committed.
    releaseSlow();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterCommit = await seal(late.id, { graceMs: 0 });

    expect(afterCommit.sealed).toBe(2);
    const rows = await sealed(late.id);
    expect(rows.map((row) => row.requestId)).toEqual(['slow-first', 'fast-second']);
    expectValidChain(rows);
  });

  it('reports the seal lag of a tenant in the metrics', async () => {
    const lagging = await createTestTenant(runtime, { slug: 'sealer-lag' });
    const metrics = createMetrics();
    await record(lagging.id, 'lag-1');
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await seal(lagging.id, { graceMs: 60_000, metrics });
    const whileUnsealed = metrics.get('audit_seal_lag_seconds', { tenant: lagging.id });
    await seal(lagging.id, { graceMs: 0, metrics });
    const afterSeal = metrics.get('audit_seal_lag_seconds', { tenant: lagging.id });

    expect(whileUnsealed).toBeGreaterThanOrEqual(1);
    expect(afterSeal).toBe(0);
  });

  it('runs on the sealer login, and the runtime login cannot seal at all', async () => {
    await record(a.id, 'login-check');
    const user = await asTenant(sealer, a.id, async (tx) => {
      await sealTenant(tx, { graceMs: 0 });
      const result = await tx.execute<{ user: string }>(sql`SELECT current_user AS "user"`);
      return result.rows[0]?.user;
    });
    await record(a.id, 'login-check-2');

    expect(user).toBe('audit_sealer');
    await expect(
      asTenant(runtime, a.id, (tx) => sealTenant(tx, { graceMs: 0 })),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

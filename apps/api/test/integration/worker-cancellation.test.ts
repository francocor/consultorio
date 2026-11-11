import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { loadConfig } from '../../src/main/config.js';
import { subscriptionsWiring } from '../../src/main/wiring/subscriptions.js';
import { tenancyWiring } from '../../src/main/wiring/tenancy.js';
import type { WorkerWiringContext } from '../../src/main/wiring/types.js';
import { createVideoJoinRegistry } from '../../src/modules/notifications/index.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { DUNNING_STEP_JOB } from '../../src/modules/subscriptions/index.js';
import { createTenantLifecycle } from '../../src/modules/tenancy/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { JobDefinition } from '../../src/platform/jobs/define-job.js';
import { runPending } from '../support/jobs.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import { createSubscriptionWorld, type SubscriptionWorld } from '../support/subscription-world.js';

/**
 * A cancellation reached by the WORKER (Stage 6 integration). The end of the paid period is decided
 * by `dunning.step`, which runs in the worker process: the retention subscriber (the request of the
 * cancellation export) must hear it there, not only when the API cancels. The wiring of the two
 * modules is the real one (`main/wiring`), joined by the one bus the worker context carries.
 */

let runtime: DbHandle;
let owner: pg.Client;
let world: SubscriptionWorld;
let provider: FakeHarness;
let definitions: readonly JobDefinition[];
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const setNow = (iso: string) => {
  clock.now = new Date(iso);
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  provider = fakeHarness({ clock, idempotent: false, settleWindowMs: 60_000 });
  world = await createSubscriptionWorld(runtime, { harness: provider, clock });

  const context: WorkerWiringContext = {
    config: loadConfig({
      DATABASE_URL: 'postgres://app_rw:placeholder@localhost:5432/app',
      BASE_DOMAIN: 'consultorio.test',
      PLATFORM_HOST: 'platform.consultorio.test',
      KMS_LOCAL_KEK_BASE64: Buffer.alloc(32, 7).toString('base64'),
    }),
    adapters: world.adapters,
    email: world.email,
    clock: () => clock.now,
    videoJoin: createVideoJoinRegistry(),
    // The one bus of the worker process: the billing publishes on it, retention subscribes to it.
    tenantLifecycle: createTenantLifecycle(),
  };
  const job = { client: world.recorded, db: runtime.db, metrics: {} as never, log: {} as never };
  // The two modules contribute to the same worker, the way main.ts joins them.
  const tenancy = tenancyWiring.worker?.(context);
  definitions = [
    ...(subscriptionsWiring.worker?.(context).jobs?.(job) ?? []),
    ...(tenancy?.jobs?.(job) ?? []),
  ];
});

afterAll(async () => {
  await world.stop();
  await owner.end();
  await runtime.close();
});

describe('the cancellation that the worker reaches', () => {
  it('asks for the export of the organization when dunning.step ends the paid period', async () => {
    setNow('2026-09-01T15:00:00.000Z');
    const org = await world.organization();
    setNow('2026-10-20T15:00:00.000Z');
    await org.refresh();
    expect((await org.checkout()).statusCode).toBe(200);
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    await provider.authorize(preapprovalId);
    await reconcileSubscription(world.deps, org.tenant.id);
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);
    setNow('2026-10-25T15:00:00.000Z');
    await org.refresh();
    expect((await org.api.post('/subscription/cancel', org.owner)).statusCode).toBe(200);
    expect(await org.rows('export_package')).toEqual([]);

    // The paid period ends: the worker's clock runs the step.
    setNow('2026-11-01T03:00:01.000Z');
    await world.recorded.enqueue({} as never, DUNNING_STEP_JOB, { tenantId: org.tenant.id });
    await runPending(runtime.db, world.recorded, definitions);

    expect(await org.subscription()).toMatchObject({ status: 'cancelled' });
    const requested = await org.run(sql`select kind, status from export_package`);
    expect(requested).toEqual([{ kind: 'administrative', status: 'queued' }]);
    const audits = await org.run(
      sql`select action from audit_event where action = 'export.cancellation.requested'`,
    );
    expect(audits).toHaveLength(1);
  }, 120_000);
});

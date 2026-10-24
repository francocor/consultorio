import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createBoss, createJobClient } from '../../src/platform/jobs/boss.js';
import { JOBS_SCHEMA, QUEUES } from '../../src/platform/jobs/queues.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let boss: PgBoss;
let a: TestTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'queues-a' });
  boss = createBoss(inject('runtimeUrl'), 'api');
  await boss.start();
}, 60_000);

afterAll(async () => {
  await boss.stop({ graceful: false });
  await runtime.close();
});

const STAGE_3_QUEUES = [
  'reminder.plan',
  'reminder.send',
  'reminder.sweep',
  'otp.send',
  'booking.purge',
  'waitlist.match',
  'waitlist.offer',
  'waitlist.expire',
  'video.link.create',
];

const STAGE_4_QUEUES = [
  'afip.issue',
  'fiscal.credential_watch',
  'invoice.pdf',
  'invoice.deliver',
  'export.build',
];

const STAGE_5_QUEUES = [
  'erx.submit',
  'erx.reconcile',
  'consent.expire',
  'portal.majority_review',
  'portal.code_send',
];

describe('the queues the installer creates', () => {
  it('creates every queue of the application, the Stage 3, 4 and 5 ones included', async () => {
    const existing = (await boss.getQueues()).map((queue) => queue.name);

    expect(existing).toEqual(expect.arrayContaining(QUEUES.map((queue) => queue.name)));
    expect(existing).toEqual(expect.arrayContaining(STAGE_3_QUEUES));
    expect(existing).toEqual(expect.arrayContaining(STAGE_4_QUEUES));
    expect(existing).toEqual(expect.arrayContaining(STAGE_5_QUEUES));
    expect(JOBS_SCHEMA).toBe('pgboss');
  });

  it.each([...STAGE_3_QUEUES, ...STAGE_4_QUEUES, ...STAGE_5_QUEUES].map((name) => [name] as const))(
    'accepts a job for %s from a request transaction',
    async (name) => {
      const client = createJobClient(boss);

      const id = await asTenant(runtime, a.id, (tx) =>
        client.enqueue(tx, name, { tenantId: a.id }, { startAfter: 3600 }),
      );

      expect(id).toEqual(expect.any(String));
      expect((await boss.findJobs(name, { id: id ?? '' }))[0]?.state).toBe('created');
    },
  );
});

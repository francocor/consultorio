import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { exportSubscriptions } from '../../src/modules/subscriptions/application/export-contributor.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import { createSubscriptionWorld, type SubscriptionWorld } from '../support/subscription-world.js';

/**
 * Judgment day of Stage 6, round 1, the payments half (JD-S6 R1): the small fixes that need a database
 * and a provider that is NOT idempotent. The larger ones have a file of their own
 * (`subscription-superseded.test.ts`, `subscription-parked.test.ts`, `subscription-ledger.test.ts`).
 */

let runtime: DbHandle;
let world: SubscriptionWorld;
let provider: FakeHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  provider = fakeHarness({ clock, idempotent: false, settleWindowMs: 60_000 });
  world = await createSubscriptionWorld(runtime, {
    harness: provider,
    clock,
    providerTimeoutMs: 400,
  });
});

afterAll(async () => {
  await world.stop();
  await runtime.close();
});

describe('the export of the subscription (S6-11)', () => {
  it('lists the payments without the id the provider gave them', async () => {
    const org = await world.organization();
    const subscription = await org.subscription();
    await org.run(sql`
      insert into subscription_payment
        (tenant_id, subscription_id, provider_payment_id, purpose, reference, amount_cents, status,
         period, credited, approved_at, provider_created_at)
      values (current_setting('app.tenant_id')::uuid, ${String(subscription['id'])}::uuid,
         'PAY-SECRET-IDENTIFIER-1', 'charge', 'sub:x:1', 1800000, 'approved', '2026-09', true,
         now(), now())`);

    const exported = (await world.deps.withTenant(
      { tenantId: org.tenant.id, userId: org.owner.user.id },
      (tx) => exportSubscriptions({ tx } as never),
    )) as { payments: Record<string, unknown>[] };

    expect(exported.payments).toHaveLength(1);
    expect(exported.payments[0]).toMatchObject({ amountCents: 1_800_000, status: 'approved' });
    expect(JSON.stringify(exported)).not.toContain('PAY-SECRET-IDENTIFIER-1');
    expect(Object.keys(exported.payments[0] ?? {})).not.toContain('providerPaymentId');
  });
});

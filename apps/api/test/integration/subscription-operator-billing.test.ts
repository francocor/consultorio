import { randomUUID } from 'node:crypto';

import {
  OperatorPaymentsResponse,
  OperatorRefundResponse,
  OperatorResolveParkedResponse,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startCheckout } from '../../src/modules/subscriptions/application/checkout.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { refundPayment } from '../../src/modules/subscriptions/application/refunds.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
} from '../support/operator.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';

/**
 * What the platform operator decides about billing (JD-S6 R1, S6-6 and C1): refund a payment, let a
 * parked subscription go, mark a surplus as looked at. Against a provider that is NOT idempotent: a
 * double click, two operators at once and an answer that is lost give ONE refund, and every decision
 * carries the operator, the reason and the token in the trail of the platform.
 */

/** A matcher for part of an object, typed so that the linter sees no `any`. */
const containing = (value: Record<string, unknown>): unknown => expect.objectContaining(value);

let runtime: DbHandle;
let owner: pg.Client;
let operators: OperatorHarness;
let world: SubscriptionWorld;
let provider: FakeHarness;
let cookie: string;
let operatorId: string;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const SETTLE_MS = 60_000;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  operators = createOperatorHarness();
  provider = fakeHarness({ clock, idempotent: false, settleWindowMs: SETTLE_MS });
  world = await createSubscriptionWorld(runtime, {
    harness: provider,
    clock,
    providerTimeoutMs: 400,
    app: { operator: { database: operators.db, secrets: operators.secrets } },
  });
  const operator = await operators.addOperator();
  operatorId = operator.id;
  cookie = await operatorSession(world.app, operator, createTestClock(clock.now));
});

afterAll(async () => {
  await world.stop();
  await operators.close();
  await owner.end();
  await runtime.close();
});

const reconcile = (org: SubscriptionOrganization) =>
  reconcileSubscription(world.deps, org.tenant.id);

const REASON = 'El pago esta duplicado, lo verifique en el panel del proveedor.';
let addresses = 0;
const post = (url: string, payload: unknown) =>
  world.app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', ...platformHeaders(cookie) },
    payload: JSON.stringify(payload),
    remoteAddress: `10.97.${String(Math.floor((addresses += 1) / 200))}.${String(addresses % 200)}`,
  });
const get = (url: string) =>
  world.app.inject({
    method: 'GET',
    url,
    headers: platformHeaders(cookie),
    remoteAddress: '10.97.250.1',
  });

async function paid() {
  const org = await world.organization();
  const started = await startCheckout(world.deps, {
    tenantId: org.tenant.id,
    userId: org.owner.user.id,
    actor: {
      userId: org.owner.user.id,
      actingRole: 'owner',
      ip: null,
      userAgent: null,
      requestId: null,
    },
  });
  expect(started.status).toBe('ready');
  const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
  provider.fake.authorize(preapprovalId);
  const charged = provider.fake.chargeCycle(preapprovalId, 'approved');
  await reconcile(org);
  const [payment] = await org.rows('subscription_payment');
  if (!payment) throw new Error('no payment');
  return { org, preapprovalId, payment, charged, id: String(payment['id']) };
}

const refundUrl = (org: SubscriptionOrganization, id: string) =>
  `/operator/tenants/${org.tenant.id}/subscription/payments/${id}/refund`;
const refundOf = (amountCents: number, token = randomUUID()) => ({
  amountCents,
  reason: REASON,
  token,
  confirmed: true,
});
const refundsAt = (paymentId: string) =>
  provider.fake.payments().find((p) => p.paymentId === paymentId)?.refunds ?? [];
const platformAudit = async (action: string, tenantId: string) =>
  (
    await owner.query(
      `select operator_id::text as operator_id, reason, resource_id, metadata
         from platform_audit_event where action = $1 and target_tenant_id = $2 order by id`,
      [action, tenantId],
    )
  ).rows as {
    operator_id: string;
    reason: string | null;
    resource_id: string;
    metadata: unknown;
  }[];

describe('the operator lists the payments of an organization without a payer (JD-S6 R1, S6-6)', () => {
  it('shows amounts, states and flags, with the id of the platform, and never the id of the provider', async () => {
    const { org, charged } = await paid();

    const response = await get(`/operator/tenants/${org.tenant.id}/subscription/payments`);

    expect(response.statusCode, response.body).toBe(200);
    const listed = OperatorPaymentsResponse.parse(response.json());
    expect(listed.payments).toEqual([
      containing({ purpose: 'charge', amountCents: 1_800_000, surplus: false }),
    ]);
    expect(response.body).not.toContain(charged.paymentId);
    expect(response.body).not.toMatch(/payer|email|@/);
  });
});

describe('an operator refund is made once, whatever the clicks and the provider do (JD-S6 R1, S6-6)', () => {
  it('refunds with the operator, the reason and the token on the record', async () => {
    const { org, payment, charged, id } = await paid();
    const request = refundOf(500_000);

    const response = await post(refundUrl(org, id), request);

    expect(response.statusCode, response.body).toBe(200);
    expect(OperatorRefundResponse.parse(response.json())).toEqual({
      status: 'refunded',
      amountCents: 500_000,
    });
    expect(refundsAt(charged.paymentId)).toHaveLength(1);
    expect(await org.rows('subscription_refund')).toEqual([
      containing({ amount_cents: '500000', source: 'operator' }),
    ]);
    const [entry] = await platformAudit('subscription.refunded', org.tenant.id);
    expect(entry).toMatchObject({ operator_id: operatorId, reason: REASON, resource_id: id });
    const trail = await org.run(
      sql`select actor_user_id::text as actor, metadata from audit_event where action = 'subscription.refunded'`,
    );
    expect(trail).toEqual([
      { actor: operatorId, metadata: containing({ reason: 'operator_refund' }) },
    ]);
    expect(JSON.stringify(trail)).not.toContain(REASON);
    expect(payment['status']).toBe('approved');
  });

  it('gives one refund for a double click, and the same answer the second time', async () => {
    const { org, charged, id } = await paid();
    const request = refundOf(1_800_000);

    const first = await post(refundUrl(org, id), request);
    const second = await post(refundUrl(org, id), request);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(second.json()).toEqual(first.json());
    expect(refundsAt(charged.paymentId)).toHaveLength(1);
    expect(await org.rows('subscription_refund')).toHaveLength(1);
  });

  it('gives one refund when two operators ask at once for the whole payment', async () => {
    const { org, charged, id } = await paid();

    const [a, b] = await Promise.all([
      post(refundUrl(org, id), refundOf(1_800_000)),
      post(refundUrl(org, id), refundOf(1_800_000)),
    ]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(refundsAt(charged.paymentId)).toHaveLength(1);
    expect(
      provider.fake.payments().find((p) => p.paymentId === charged.paymentId)?.refundedCents,
    ).toBe(1_800_000);
    expect(await org.rows('subscription_refund')).toHaveLength(1);
  });

  it('refuses more than is left, and a payment of another organization', async () => {
    const mine = await paid();
    const other = await paid();
    await post(refundUrl(mine.org, mine.id), refundOf(1_000_000));

    const tooMuch = await post(refundUrl(mine.org, mine.id), refundOf(900_000));
    const foreign = await post(refundUrl(mine.org, other.id), refundOf(100_000));

    expect(tooMuch.statusCode).toBe(409);
    expect(foreign.statusCode).toBe(404);
    expect(refundsAt(mine.charged.paymentId)).toHaveLength(1);
    expect(refundsAt(other.charged.paymentId)).toHaveLength(0);
  });

  it('asks for the confirmation, a reason and a token', async () => {
    const { org, id } = await paid();
    const valid = refundOf(100_000);

    for (const body of [
      { ...valid, confirmed: false },
      { ...valid, reason: 'corto' },
      { ...valid, token: 'not-a-uuid' },
      { amountCents: 100_000, reason: REASON, confirmed: true },
      { ...valid, amountCents: 0 },
    ]) {
      const response = await post(refundUrl(org, id), body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it('survives an answer that is lost: one refund at the provider, recorded once, and the same token tells the same story', async () => {
    const { org, charged, id } = await paid();
    const request = refundOf(1_800_000);
    await provider.setMode('lose_answer');

    const lost = await post(refundUrl(org, id), request);
    await provider.setMode('ok');

    expect(lost.statusCode).toBe(503);
    expect(refundsAt(charged.paymentId)).toHaveLength(1);
    // While the outcome is unknown nothing is sent again: neither the same click nor another operator's.
    const again = await post(refundUrl(org, id), request);
    const other = await post(refundUrl(org, id), refundOf(1_800_000));
    expect(again.statusCode).toBe(409);
    expect([409]).toContain(other.statusCode);
    expect(refundsAt(charged.paymentId)).toHaveLength(1);

    world.advance(SETTLE_MS + 30_000);
    await reconcile(org);

    expect(await org.rows('subscription_refund')).toHaveLength(1);
    const after = await post(refundUrl(org, id), request);
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json()).toEqual({ status: 'refunded', amountCents: 1_800_000 });
    expect(refundsAt(charged.paymentId)).toHaveLength(1);
  });

  it('survives a refund that lands after the caller gave up', async () => {
    const { org, charged, id } = await paid();
    const token = randomUUID();
    const asked = (clientToken: string) => ({
      tenantId: org.tenant.id,
      paymentId: id,
      amountCents: 1_800_000,
      actor: { userId: operatorId, actingRole: null, ip: null, userAgent: null, requestId: null },
      requestedBy: operatorId,
      clientToken,
    });
    const slow = provider.fake.hold({ completeLate: true });

    // The call is held at the provider and the caller (with the short timeout of the world) gives up.
    const gaveUp = await refundPayment(world.deps, asked(token));
    const early = await refundPayment(world.deps, asked(randomUUID()));
    expect(gaveUp.status).toBe('unavailable');
    expect(early.status).toBe('in_progress');
    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(refundsAt(charged.paymentId)).toHaveLength(1);

    world.advance(SETTLE_MS + 30_000);
    await reconcile(org);
    const replay = await post(refundUrl(org, id), {
      amountCents: 1_800_000,
      reason: REASON,
      token,
      confirmed: true,
    });

    expect(replay.statusCode, replay.body).toBe(200);
    expect(refundsAt(charged.paymentId)).toHaveLength(1);
    expect(await org.rows('subscription_refund')).toHaveLength(1);
  });

  it('answers a token from every attempt it made, so a released one then a confirmed one never gives a second refund (JD-S6 R2-1)', async () => {
    const { org, charged, id } = await paid();
    const token = randomUUID();
    const asked = {
      tenantId: org.tenant.id,
      paymentId: id,
      amountCents: 500_000,
      actor: { userId: operatorId, actingRole: null, ip: null, userAgent: null, requestId: null },
      requestedBy: operatorId,
      clientToken: token,
    };

    // The first attempt is released (the provider answered that it did nothing), the second is confirmed.
    const refusing = {
      ...world.deps,
      adapters: {
        forTenant: () => ({
          ...provider.gateway,
          getPayment: provider.gateway.getPayment.bind(provider.gateway),
          refund: () =>
            Promise.resolve({
              status: 'retryable' as const,
              message: 'service unavailable',
              outcomeUnknown: false,
            }),
        }),
      },
    } as unknown as typeof world.deps;
    const first = await refundPayment(refusing, asked);
    const second = await refundPayment(world.deps, asked);
    // The same token a third time: the answer of the confirmed attempt, not a new partial refund.
    const third = await refundPayment(world.deps, asked);

    expect(first.status).toBe('unavailable');
    expect(second.status).toBe('refunded');
    expect(third).toEqual(second);
    expect(refundsAt(charged.paymentId)).toHaveLength(1);
    expect(await org.rows('subscription_refund')).toHaveLength(1);
    const attempts = await org.run(
      sql`select state from subscription_attempt where kind = 'refund' order by marked_at`,
    );
    expect(attempts).toEqual([{ state: 'released' }, { state: 'confirmed' }]);
  });

  it('marks a surplus as looked at when it is given back in full', async () => {
    const { org, preapprovalId } = await paid();
    const twice = provider.fake.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);
    const surplus = (await org.rows('subscription_payment')).find((p) => p['surplus'] === true);
    expect(surplus?.['surplus_reviewed_at']).toBeNull();

    const response = await post(refundUrl(org, String(surplus?.['id'])), refundOf(1_800_000));

    expect(response.statusCode, response.body).toBe(200);
    expect(refundsAt(twice.paymentId)).toHaveLength(1);
    const after = (await org.rows('subscription_payment')).find((p) => p['id'] === surplus?.['id']);
    expect(after?.['surplus_reviewed_at']).not.toBeNull();
  });
});

describe('the operator marks a surplus as looked at (JD-S6 R1, S6-6)', () => {
  it('records who looked and why, once, and a payment that is not a surplus is refused', async () => {
    const { org, preapprovalId, id } = await paid();
    provider.fake.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);
    const surplus = (await org.rows('subscription_payment')).find((p) => p['surplus'] === true);
    const url = (paymentId: string) =>
      `/operator/tenants/${org.tenant.id}/subscription/payments/${paymentId}/review`;

    const reviewed = await post(url(String(surplus?.['id'])), { reason: REASON });
    const twice = await post(url(String(surplus?.['id'])), { reason: REASON });
    const ordinary = await post(url(id), { reason: REASON });

    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(twice.statusCode).toBe(409);
    expect(ordinary.statusCode).toBe(409);
    expect((await platformAudit('subscription.surplus_reviewed', org.tenant.id))[0]).toMatchObject({
      operator_id: operatorId,
      reason: REASON,
    });
    expect(
      await org.run(
        sql`select reason from audit_event where action = 'subscription.surplus_reviewed'`,
      ),
    ).toEqual([{ reason: 'operator_decision' }]);
    const view = await get(`/operator/tenants/${org.tenant.id}/subscription`);
    expect(view.json()).toMatchObject({ surplusFlags: 0 });
  });
});

describe('the operator lets a parked subscription go (JD-S6 R1, C1)', () => {
  it('clears it with the reason and the operator on the record, and says so when there is nothing to clear', async () => {
    const org = await world.organization();
    await org.run(
      sql`update subscription set attention_reason = 'identity_mismatch', attention_at = now()`,
    );
    const url = `/operator/tenants/${org.tenant.id}/subscription/resolve-parked`;

    const none = await post(url, { reason: 'corto' });
    const resolved = await post(url, { reason: REASON });
    const again = await post(url, { reason: REASON });

    expect(none.statusCode).toBe(400);
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(OperatorResolveParkedResponse.parse(resolved.json())).toEqual({
      status: 'resolved',
      was: 'identity_mismatch',
    });
    expect(again.statusCode).toBe(409);
    expect(await org.subscription()).toMatchObject({ attention_reason: null });
    expect((await platformAudit('subscription.parked_resolved', org.tenant.id))[0]).toMatchObject({
      operator_id: operatorId,
      reason: REASON,
    });
  });

  it('does not waive the wait for an amount the owner has to authorize', async () => {
    const org = await world.organization();
    await org.run(
      sql`insert into statement (tenant_id, subscription_id, period, plan_id, professionals_counted,
                                  base_cents, total_cents, overage_cap_messages, lines, published_at, collect_after)
            select current_setting('app.tenant_id')::uuid, s.id, '2026-09', s.plan_id, 1, 1200000, 1200000, 300,
                   '[]'::jsonb, now(), now() + interval '3 days' from subscription s`,
    );
    await org.run(
      sql`update subscription set attention_reason = 'reauthorization_needed', attention_at = now(),
                 authorized_amount_cents = 1800000`,
    );

    const response = await post(`/operator/tenants/${org.tenant.id}/subscription/resolve-parked`, {
      reason: REASON,
    });

    expect(response.statusCode).toBe(409);
    expect(await org.subscription()).toMatchObject({ attention_reason: 'reauthorization_needed' });
  });
});

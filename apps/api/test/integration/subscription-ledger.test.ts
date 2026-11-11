import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startCheckout } from '../../src/modules/subscriptions/application/checkout.js';
import { createOverdueLink } from '../../src/modules/subscriptions/application/management.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';

/**
 * What the ledger credits, against a provider that is NOT idempotent: only payments that are ours
 * (A-W10), none that was given back before it was counted and no failure of a month that is already
 * paid (B-T2), and a month that an overdue link paid is not paid a second time by the retry of the
 * recurring charge (S6-6). JD-S6 R1.
 */

/** A matcher for part of an object, typed so that the linter sees no `any`. */
const containing = (value: Record<string, unknown>): unknown => expect.objectContaining(value);

let runtime: DbHandle;
let world: SubscriptionWorld;
let provider: FakeHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const SETTLE_MS = 60_000;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  provider = fakeHarness({ clock, idempotent: false, settleWindowMs: SETTLE_MS });
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

const reconcile = (org: SubscriptionOrganization) =>
  reconcileSubscription(world.deps, org.tenant.id);

const actorOf = (org: SubscriptionOrganization) => ({
  userId: org.owner.user.id,
  actingRole: 'owner' as const,
  ip: null,
  userAgent: null,
  requestId: null,
});
const owner = (org: SubscriptionOrganization) => ({
  tenantId: org.tenant.id,
  userId: org.owner.user.id,
  actor: actorOf(org),
});

async function subscribed() {
  const org = await world.organization();
  const started = await startCheckout(world.deps, owner(org));
  expect(started.status).toBe('ready');
  const id = String((await org.subscription())['provider_preapproval_id']);
  provider.fake.authorize(id);
  await reconcile(org);
  expect(await org.subscription()).toMatchObject({ status: 'active' });
  return { org, preapprovalId: id };
}

/** The refunds the provider made on payments of this organization (the provider is shared by the file). */
async function refundsAtProvider(org: SubscriptionOrganization) {
  const id = String((await org.subscription())['id']);
  return provider.fake
    .payments()
    .filter((p) => p.externalReference.includes(`:${id}:`))
    .flatMap((p) => p.refunds);
}

const paymentsOf = (org: SubscriptionOrganization) =>
  org.run(
    sql`select purpose, status, surplus, credited, period, amount_cents, refunded_cents, surplus_reviewed_at
          from subscription_payment order by provider_created_at, id`,
  );
const auditOf = (org: SubscriptionOrganization, action: string) =>
  org.run(sql`select metadata, reason from audit_event where action = ${action} order by id`);

describe('the ledger credits only a payment that is ours (JD-S6 R1, A-W10)', () => {
  it('flags the payment of a link made under our reference for another amount, and credits the one that matches', async () => {
    const { org } = await subscribed();
    // The subscription owes a month: a rejected charge, then the link the owner asked for.
    const { preapprovalId } = {
      preapprovalId: String((await org.subscription())['provider_preapproval_id']),
    };
    provider.fake.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ status: 'past_due' });
    const link = await createOverdueLink(world.deps, owner(org));
    expect(link.status).toBe('ready');
    const [made] = provider.fake.paymentLinks().slice(-1);
    if (!made) throw new Error('no link');

    // A resend of the link, which the provider did not recognize, lands under the same reference with
    // another amount, and somebody pays it.
    const stranger = await provider.gateway.createPaymentLink(
      {
        externalReference: made.externalReference,
        payerEmail: made.payerEmail,
        title: 'Otro pago',
        amountCents: made.amountCents + 1,
        currency: 'ARS',
        backUrl: 'https://example.invalid/subscription',
        expiresAt: new Date(clock.now.getTime() + 86_400_000).toISOString(),
      },
      'another-key',
    );
    if (stranger.status !== 'created') throw new Error('the second link was not made');
    provider.fake.payLink(stranger.link.linkId);
    provider.fake.payLink(made.linkId);
    await reconcile(org);

    const payments = await paymentsOf(org);
    const overdue = payments.filter((p) => p['purpose'] === 'overdue');
    expect(overdue).toHaveLength(2);
    expect(overdue.filter((p) => p['surplus'] === false)).toEqual([
      containing({
        credited: true,
        period: '2026-10',
        amount_cents: String(made.amountCents),
      }),
    ]);
    expect(overdue.filter((p) => p['surplus'] === true)).toEqual([
      containing({
        credited: true,
        period: null,
        amount_cents: String(made.amountCents + 1),
      }),
    ]);
    expect(await auditOf(org, 'subscription.surplus_flagged')).toEqual([
      { metadata: containing({ reason: 'foreign_link' }), reason: null },
    ]);
    expect(await org.subscription()).toMatchObject({ status: 'active' });
  });
});

describe('a payment that was given back before it was counted credits nothing (JD-S6 R1, B-T2)', () => {
  it('records a charge first seen as refunded without paying the month', async () => {
    const { org, preapprovalId } = await subscribed();
    const charged = provider.fake.chargeCycle(preapprovalId, 'approved');
    // The provider gives it back before the platform has looked.
    const given = await provider.gateway.refund(
      { paymentId: charged.paymentId, amountCents: charged.amountCents },
      'refund-key',
    );
    expect(given.status).toBe('refunded');

    await reconcile(org);

    expect(await paymentsOf(org)).toEqual([
      containing({ status: 'refunded', credited: true, surplus: false, period: null }),
    ]);
    expect((await org.subscription())['paid_through']).toBeNull();
  });

  it('does not turn an active subscription past due for a failure of a month that a recorded payment covers', async () => {
    const { org, preapprovalId } = await subscribed();
    provider.fake.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ status: 'active' });

    // The same month, a retry that failed, seen for the first time in a later pass.
    world.advance(60_000);
    provider.fake.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);

    expect(await org.subscription()).toMatchObject({ status: 'active', grace_ends_at: null });
  });
});

describe('a month that an overdue link paid is not paid twice (JD-S6 R1, S6-6)', () => {
  it('gives the retry of the recurring charge back by itself, once, even when the provider loses the answer', async () => {
    const { org, preapprovalId } = await subscribed();
    provider.fake.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ status: 'past_due' });

    // The link asks for what failed, not for whatever the preapproval is authorized for now.
    const link = await createOverdueLink(world.deps, owner(org));
    expect(link.status).toBe('ready');
    const [made] = provider.fake.paymentLinks().slice(-1);
    expect(made?.amountCents).toBe(1_800_000);
    provider.fake.payLink(made?.linkId ?? '');
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ status: 'active' });

    // The preapproval retries the same month and succeeds: the second payment of the month.
    await provider.setMode('lose_answer');
    provider.fake.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);
    await provider.setMode('ok');

    // The refund was applied at the provider and its answer was lost: one refund exists, and the
    // platform does not send another while the outcome is not known.
    expect(await refundsAtProvider(org)).toHaveLength(1);
    expect(await org.rows('subscription_refund')).toHaveLength(0);
    await reconcile(org);
    expect(await refundsAtProvider(org)).toHaveLength(1);

    // After the window the platform reads the payment, finds the refund and records it. Once.
    world.advance(SETTLE_MS + 30_000);
    await reconcile(org);
    await reconcile(org);

    expect(await refundsAtProvider(org)).toHaveLength(1);
    expect(await org.rows('subscription_refund')).toHaveLength(1);
    const payments = await paymentsOf(org);
    expect(payments.filter((p) => p['surplus'] === true)).toEqual([
      containing({ purpose: 'charge', status: 'refunded' }),
    ]);
    // Given back in full, it has been looked at: it no longer counts as an item waiting for the operator.
    expect(payments.find((p) => p['surplus'] === true)?.['surplus_reviewed_at']).not.toBeNull();
    expect(payments.find((p) => p['purpose'] === 'overdue')).toMatchObject({
      surplus: false,
      period: '2026-10',
    });
    expect(await org.subscription()).toMatchObject({ status: 'active' });
    const refunds = await auditOf(org, 'subscription.refunded');
    expect(refunds).toEqual([
      { metadata: containing({ reason: 'duplicate_of_overdue_link' }), reason: null },
    ]);
  });

  it('leaves an ordinary second payment of a month to the operator: it is flagged, not refunded', async () => {
    const { org, preapprovalId } = await subscribed();
    provider.fake.chargeCycle(preapprovalId, 'approved');
    provider.fake.chargeCycle(preapprovalId, 'approved');

    await reconcile(org);
    await reconcile(org);

    const payments = await paymentsOf(org);
    expect(payments.filter((p) => p['surplus'] === true)).toEqual([
      containing({
        status: 'approved',
        refunded_cents: '0',
        surplus_reviewed_at: null,
      }),
    ]);
    expect(await refundsAtProvider(org)).toHaveLength(0);
  });
});

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startCheckout } from '../../src/modules/subscriptions/application/checkout.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';

/**
 * A preapproval that was replaced is cancelled before the next one is asked for, and one that charges
 * next to the one the subscription holds is found and stopped (JD-S6 R1, C2). Everything runs against
 * a provider that is NOT idempotent, that pauses and resumes preapprovals, and whose requests can land
 * after the caller gave up. The invariant: never charge twice, and never credit a payment that is not
 * ours.
 */

/** A matcher for part of an object, typed so that the linter sees no `any`. */
const containing = (value: Record<string, unknown>): unknown => expect.objectContaining(value);

let runtime: DbHandle;
let world: SubscriptionWorld;
let provider: FakeHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const SETTLE_MS = 60_000;
const TIMEOUT_MS = 400;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  provider = fakeHarness({ clock, idempotent: false, settleWindowMs: SETTLE_MS });
  world = await createSubscriptionWorld(runtime, {
    harness: provider,
    clock,
    providerTimeoutMs: TIMEOUT_MS,
  });
});

afterAll(async () => {
  await world.stop();
  await runtime.close();
});

const reconcile = (org: SubscriptionOrganization) =>
  reconcileSubscription(world.deps, org.tenant.id);

/**
 * The checkout of the owner, called as the route calls it but with the clock and the timeout of the
 * world (400 ms), so a request that is held at the provider is given up on quickly.
 */
const checkout = (org: SubscriptionOrganization) =>
  startCheckout(world.deps, {
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

/** The preapprovals the provider holds under the references of this organization's subscription. */
async function heldBy(org: SubscriptionOrganization) {
  const id = String((await org.subscription())['id']);
  return provider.fake
    .preapprovals()
    .filter((entry) => entry.externalReference.startsWith(`sub:${id}:`));
}

const liveOf = async (org: SubscriptionOrganization) =>
  (await heldBy(org)).filter((entry) => entry.status !== 'cancelled');

/** An organization whose payer authorized the preapproval and the platform knows it. */
async function subscribed() {
  const org = await world.organization();
  expect((await checkout(org)).status).toBe('ready');
  const [first] = await heldBy(org);
  if (!first) throw new Error('no preapproval');
  provider.fake.authorize(first.preapprovalId);
  await reconcile(org);
  expect(await org.subscription()).toMatchObject({
    status: 'active',
    authorization_state: 'authorized',
  });
  return { org, first: first.preapprovalId };
}

const auditOf = (org: SubscriptionOrganization, action: string) =>
  org.run(sql`select metadata from audit_event where action = ${action} order by id`);

describe('a replaced preapproval is cancelled before another is asked for (JD-S6 R1, C2)', () => {
  it('cancels a paused preapproval when the owner starts again: exactly one stays alive, and a resume of the first one is impossible', async () => {
    const { org, first } = await subscribed();
    provider.fake.pause(first);
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ authorization_state: 'lost' });

    const again = await checkout(org);

    expect(again.status).toBe('ready');
    const held = await heldBy(org);
    expect(held).toHaveLength(2);
    expect(held.find((entry) => entry.preapprovalId === first)?.status).toBe('cancelled');
    const live = await liveOf(org);
    expect(live).toHaveLength(1);
    expect(live[0]?.status).toBe('pending');
    // The payer cannot bring the first one back: the provider never reactivates a cancelled one.
    expect(() => {
      provider.fake.resume(first);
    }).toThrow();
    expect(await liveOf(org)).toHaveLength(1);
    // The platform said what it did.
    expect(await auditOf(org, 'subscription.preapproval_cancelled')).toEqual([
      { metadata: containing({ reason: 'superseded', providerPreapprovalId: first }) },
    ]);
  });

  it('asks for nothing new while the cancellation of the old one is in flight and lands late; then asks once', async () => {
    const { org, first } = await subscribed();
    provider.fake.pause(first);
    await reconcile(org);
    const slow = provider.fake.hold({ completeLate: true });

    // The cancel is held at the provider and the caller gives up on it: nothing is created next to it.
    const attempted = checkout(org);
    await slow.entered;
    const unknown = await attempted;
    expect(unknown.status).toBe('unavailable');
    expect(await heldBy(org)).toHaveLength(1);
    expect(await org.rows('subscription_attempt')).toEqual(
      expect.arrayContaining([
        containing({
          kind: 'cancel',
          state: 'marked',
          outcome_unknown: true,
          resource_id: first,
        }),
      ]),
    );

    // A second click while it is in flight sends nothing either.
    const second = await checkout(org);
    expect(second.status).toBe('in_progress');
    expect(await heldBy(org)).toHaveLength(1);

    // The cancel lands late. Still nothing new until the platform has looked at what the provider holds.
    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await heldBy(org))[0]?.status).toBe('cancelled');
    const early = await checkout(org);
    expect(early.status).toBe('in_progress');
    expect(await heldBy(org)).toHaveLength(1);

    // After the window the request settles (the first one is cancelled) and ONE new preapproval is made.
    world.advance(SETTLE_MS + TIMEOUT_MS + 1_000);
    const after = await checkout(org);
    expect(after.status).toBe('ready');
    expect(await heldBy(org)).toHaveLength(2);
    expect(await liveOf(org)).toHaveLength(1);
  });

  it('does not ask for a new preapproval while the provider cannot say whether the old one is alive', async () => {
    const { org, first } = await subscribed();
    provider.fake.pause(first);
    await reconcile(org);
    await provider.setMode('down');

    const response = await checkout(org);

    await provider.setMode('ok');
    expect(response.status).toBe('unavailable');
    expect(await heldBy(org)).toHaveLength(1);
    expect((await heldBy(org))[0]?.status).toBe('paused');
  });

  it('cancels, before creating, a preapproval it cannot even tell is its own by id: one found by the reference of a request it gave up on', async () => {
    const org = await world.organization();
    const id = String((await org.subscription())['id']);
    // A request for a preapproval is held, the caller gives up and the platform releases it later...
    const slow = provider.fake.hold({ completeLate: true });
    const attempted = checkout(org);
    await slow.entered;
    expect((await attempted).status).toBe('unavailable');
    world.advance(SETTLE_MS + TIMEOUT_MS + 1_000);
    await reconcile(org);
    expect(await org.rows('subscription_attempt')).toEqual([
      containing({ kind: 'preapproval', state: 'released' }),
    ]);

    // ...and then the request lands. The preapproval exists at the provider and nobody records it.
    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await liveOf(org)).toHaveLength(1);

    // The owner starts again: the late preapproval is found by its reference and cancelled first.
    const again = await checkout(org);

    expect(again.status).toBe('ready');
    const held = await heldBy(org);
    expect(held.map((entry) => entry.externalReference)).toEqual([`sub:${id}:1`, `sub:${id}:2`]);
    expect(held[0]?.status).toBe('cancelled');
    expect(await liveOf(org)).toHaveLength(1);
  });
});

describe('the reconcile finds a preapproval that charges next to the one the subscription holds (JD-S6 R1, C2)', () => {
  it('cancels a second live preapproval under our reference, sees what it charged and flags it as a surplus: never credited, refundable', async () => {
    const { org, first } = await subscribed();
    const [held] = await heldBy(org);
    if (!held) throw new Error('no preapproval');
    // A resend of the creation, which the provider did not recognize as the same, lands late.
    const landed = await provider.gateway.createPreapproval(
      {
        externalReference: held.externalReference,
        payerEmail: held.payerEmail,
        reason: 'Plan Estandar - 1 profesional',
        amountCents: held.amountCents,
        currency: 'ARS',
        backUrl: 'https://example.invalid/subscription',
      },
      'a-resend-with-another-key',
    );
    if (landed.status !== 'created') throw new Error('the late request did not land');
    const late = landed.preapproval.preapprovalId;
    expect(await liveOf(org)).toHaveLength(2);
    provider.fake.authorize(late);
    const paidThrough = (await org.subscription())['paid_through'];

    // The payer is charged by both.
    provider.fake.chargeCycle(late, 'approved');
    provider.fake.chargeCycle(first, 'approved');
    await reconcile(org);

    // The late one is stopped, and what it charged is a surplus that credits nothing.
    expect((await heldBy(org)).find((p) => p.preapprovalId === late)?.status).toBe('cancelled');
    expect(await liveOf(org)).toHaveLength(1);
    expect((await liveOf(org))[0]?.preapprovalId).toBe(first);
    const payments = await org.rows('subscription_payment');
    expect(payments).toHaveLength(2);
    const stray = payments.find((p) => p['surplus'] === true);
    const ours = payments.find((p) => p['surplus'] === false);
    expect(stray).toMatchObject({ credited: true, period: null, amount_cents: '1800000' });
    expect(ours).toMatchObject({ credited: true, period: '2026-10' });
    expect((await org.subscription())['paid_through']).not.toBe(paidThrough);
    expect(await auditOf(org, 'subscription.surplus_flagged')).toEqual([
      { metadata: containing({ reason: 'superseded_preapproval' }) },
    ]);
    expect(await auditOf(org, 'subscription.preapproval_cancelled')).toEqual([
      { metadata: containing({ reason: 'stray', providerPreapprovalId: late }) },
    ]);
    // Asking again changes nothing: nothing is cancelled or recorded twice.
    await reconcile(org);
    expect(await org.rows('subscription_payment')).toHaveLength(2);
    expect(await auditOf(org, 'subscription.preapproval_cancelled')).toHaveLength(1);
  });

  it('cancels a preapproval that landed after its request was released, without the owner doing anything', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold({ completeLate: true });
    const attempted = checkout(org);
    await slow.entered;
    expect((await attempted).status).toBe('unavailable');
    world.advance(SETTLE_MS + TIMEOUT_MS + 1_000);
    await reconcile(org);
    expect(await org.rows('subscription_attempt')).toEqual([
      containing({ kind: 'preapproval', state: 'released' }),
    ]);

    // The request lands now, long after the platform believed it never would.
    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await liveOf(org)).toHaveLength(1);
    await reconcile(org);

    expect(await liveOf(org)).toHaveLength(0);
    expect(await auditOf(org, 'subscription.preapproval_cancelled')).toEqual([
      { metadata: containing({ reason: 'stray' }) },
    ]);
  });

  it('adopts the preapproval of a request that is still pinned instead of cancelling it', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold({ completeLate: true });
    const attempted = checkout(org);
    await slow.entered;
    expect((await attempted).status).toBe('unavailable');
    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await liveOf(org)).toHaveLength(1);

    await reconcile(org);

    expect(await liveOf(org)).toHaveLength(1);
    expect(await org.rows('subscription_attempt')).toEqual([
      containing({ kind: 'preapproval', state: 'confirmed' }),
    ]);
    expect(await auditOf(org, 'subscription.preapproval_cancelled')).toEqual([]);
  });

  it('does not touch a preapproval that is not of this subscription', async () => {
    const { org } = await subscribed();
    const other = await world.organization();
    expect((await checkout(other)).status).toBe('ready');

    await reconcile(org);
    await reconcile(other);

    expect(await liveOf(other)).toHaveLength(1);
    expect(await liveOf(org)).toHaveLength(1);
  });
});

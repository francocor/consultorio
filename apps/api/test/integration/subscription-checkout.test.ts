import { CheckoutResponse, SubscriptionResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';

/**
 * The checkout of the owner (task 6.14) and the rules that keep it from charging twice or adopting a
 * payment that is not ours (payment safety), against a provider that is NOT idempotent and whose
 * requests can still be in flight after the caller gave up:
 *
 * - the intent is committed BEFORE the call, and no row lock is held while the provider answers;
 * - a second click while a request is in flight, or while its outcome is unknown, sends nothing;
 * - after an unknown outcome the provider is asked by the reference the server derived, and a
 *   preapproval is adopted only when every identifying field equals what was asked;
 * - more than one plausible preapproval, or one that is not what was asked, parks the subscription
 *   for a person and nothing is sent again.
 */

let runtime: DbHandle;
let world: SubscriptionWorld;
let provider: FakeHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const SETTLE_MS = 60_000;

/** A matcher for a text, typed so that the linter sees no `any`. */
const endingIn = (pattern: RegExp): unknown => expect.stringMatching(pattern);
const someText: unknown = expect.any(String);

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

/** The preapprovals the provider holds under the references of this organization's subscription. */
async function heldBy(org: SubscriptionOrganization) {
  const id = (await org.subscription())['id'] as string;
  return provider.fake
    .preapprovals()
    .filter((entry) => entry.externalReference.startsWith(`sub:${id}:`));
}

const reconcile = (org: SubscriptionOrganization) =>
  reconcileSubscription(world.deps, org.tenant.id);

describe('the owner subscribes through the checkout (task 6.14)', () => {
  it('gets the hosted page of the provider; the subscription stays in trial until the provider confirms', async () => {
    const org = await world.organization();

    const response = await org.checkout();

    expect(response.statusCode, response.body).toBe(200);
    const { checkoutUrl } = CheckoutResponse.parse(response.json());
    const [held] = await heldBy(org);
    expect(held).toMatchObject({ status: 'pending', checkoutUrl, amountCents: 1_800_000 });
    expect(await org.subscription()).toMatchObject({
      status: 'trial',
      authorization_state: 'pending',
      provider_preapproval_id: held?.preapprovalId,
      payment_method_label: null,
    });
  });

  it('activates only after the provider confirms the authorization, and shows the method label and the next charge', async () => {
    const org = await world.organization();
    await org.checkout();
    const [held] = await heldBy(org);
    if (!held) throw new Error('no preapproval');

    // The payer authorizes at the provider; nothing in the platform moves until it asks the provider.
    await provider.authorize(held.preapprovalId);
    expect(await org.subscription()).toMatchObject({
      status: 'trial',
      authorization_state: 'pending',
    });
    const result = await reconcile(org);

    expect(result).toMatchObject({ outcome: 'done', from: 'trial', to: 'active' });
    expect(await org.subscription()).toMatchObject({
      status: 'active',
      authorization_state: 'authorized',
      payment_method_label: 'Visa terminada en 4242',
    });
    const view = SubscriptionResponse.parse((await org.view()).json());
    expect(view.subscription).toMatchObject({
      status: 'active',
      authorization: 'authorized',
      paymentMethodLabel: 'Visa terminada en 4242',
      authorizedAmountCents: 1_800_000,
    });
    expect(view.subscription?.nextChargeAt).toEqual(expect.any(String));
  });

  it('leaves the state as it was when the owner abandons the page: no state is inferred', async () => {
    const org = await world.organization();
    await org.checkout();
    const before = await org.subscription();

    // The owner closes the page and comes back: the provider still says "pending".
    const result = await reconcile(org);

    expect(result.to).toBeNull();
    const after = await org.subscription();
    expect(after).toMatchObject({ status: 'trial', authorization_state: 'pending' });
    expect(after['paid_through']).toBeNull();
    expect(after['version']).toBe(before['version']);
  });

  it('hands out the same page for a second click: one preapproval at the provider', async () => {
    const org = await world.organization();

    const first = CheckoutResponse.parse((await org.checkout()).json());
    const second = CheckoutResponse.parse((await org.checkout()).json());

    expect(second.checkoutUrl).toBe(first.checkoutUrl);
    expect(await heldBy(org)).toHaveLength(1);
  });

  it('refuses a subscription that is already authorized, and an organization that is exempt', async () => {
    const org = await world.organization();
    await org.checkout();
    const [held] = await heldBy(org);
    await provider.authorize(held?.preapprovalId ?? '');
    await reconcile(org);
    const exempt = await world.organization({ trial: false, billingExempt: true });

    const again = await org.checkout();
    const none = await exempt.checkout();

    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'subscription_already_subscribed' });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: 'subscription_exempt' });
    expect(await exempt.rows('subscription')).toEqual([]);
  });

  it('is the owner alone: a professional, reception and an admin are denied', async () => {
    const org = await world.organization();

    for (const role of ['professional', 'reception', 'admin'] as const) {
      const session = await org.member(role);
      const response = await org.api.post('/subscription/checkout', session);
      expect(response.statusCode, role).toBe(403);
    }
    expect(await heldBy(org)).toHaveLength(0);
  });

  it('starts the trial of an organization the operator created without one, when its owner subscribes', async () => {
    const org = await world.organization({ trial: false });

    const response = await org.checkout();

    expect(response.statusCode, response.body).toBe(200);
    expect(await org.subscription()).toMatchObject({
      status: 'trial',
      authorization_state: 'pending',
    });
  });

  it('keeps no card: the subscription and the log of the provider hold references, amounts and a label', async () => {
    const org = await world.organization();
    await org.checkout();

    const columns = await org.run(
      sql`select column_name from information_schema.columns
           where table_schema = 'public' and table_name like 'subscription%'`,
    );

    const names = columns.map((row) => String(row['column_name']));
    for (const forbidden of ['card', 'pan', 'cvv', 'secret', 'token']) {
      expect(
        names.filter((name) => name.includes(forbidden)),
        forbidden,
      ).toEqual([]);
    }
  });
});

describe('payment safety: the intent is written before the call and nothing is held while the provider answers', () => {
  it('commits the mark before the provider is called, and holds no lock while it waits', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold();

    const call = org.checkout();
    await slow.entered;

    // The provider has not answered, and the mark is already there, committed.
    const [attempt] = await org.rows('subscription_attempt');
    expect(attempt).toMatchObject({ state: 'marked', kind: 'preapproval', outcome_unknown: false });
    expect(String(attempt?.['external_reference'])).toMatch(/^sub:[0-9a-f-]{36}:1$/);
    expect(String(attempt?.['idempotency_key']).length).toBeGreaterThan(10);
    expect(new Date(String(attempt?.['settle_until'])).getTime()).toBeGreaterThan(
      new Date(String(attempt?.['marked_at'])).getTime() + SETTLE_MS - 1,
    );
    // No row lock is held across the call: another transaction takes the subscription at once.
    await expect(org.run(sql`select id from subscription for update nowait`)).resolves.toHaveLength(
      1,
    );

    slow.release();
    expect((await call).statusCode).toBe(200);
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({ state: 'confirmed', resource_id: someText }),
    ]);
  });

  it('sends nothing for a second click while a request is in flight: one preapproval, and the owner is told to wait', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold();

    const first = org.checkout();
    await slow.entered;
    const second = await org.checkout();
    slow.release();
    await first;

    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'subscription_checkout_in_progress' });
    expect(await heldBy(org)).toHaveLength(1);
  });

  it('lets the pin go when the provider provably never got the request (an outage): the owner can try at once', async () => {
    const org = await world.organization();
    await provider.setMode('down');

    const refused = await org.checkout();
    await provider.setMode('ok');
    const retried = await org.checkout();

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ code: 'subscription_payments_unavailable' });
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({
        state: 'released',
        external_reference: endingIn(/:1$/),
      }),
      expect.objectContaining({
        state: 'confirmed',
        external_reference: endingIn(/:2$/),
      }),
    ]);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(await heldBy(org)).toHaveLength(1);
    expect(await org.subscription()).toMatchObject({ status: 'trial' });
  });
});

describe('payment safety: an unknown outcome is settled by looking at the provider, never by believing', () => {
  it('does not send again while the pin lasts, then adopts the one preapproval that matches in every field', async () => {
    const org = await world.organization();
    await provider.setMode('lose_answer');

    const lost = await org.checkout();
    const impatient = await org.checkout();

    expect(lost.statusCode).toBe(503);
    expect(impatient.statusCode).toBe(409);
    expect(impatient.json()).toMatchObject({ code: 'subscription_checkout_in_progress' });
    // The provider created it, and the platform did not hear: exactly one exists.
    expect(await heldBy(org)).toHaveLength(1);
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({ state: 'marked', outcome_unknown: true }),
    ]);

    world.advance(SETTLE_MS + 30_000);
    const adopted = await org.checkout();

    expect(adopted.statusCode, adopted.body).toBe(200);
    const [only] = await heldBy(org);
    expect(CheckoutResponse.parse(adopted.json()).checkoutUrl).toBe(only?.checkoutUrl);
    expect(await heldBy(org)).toHaveLength(1);
    expect(await org.subscription()).toMatchObject({
      provider_preapproval_id: only?.preapprovalId,
      authorization_state: 'pending',
    });
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({ state: 'confirmed', resource_id: only?.preapprovalId }),
    ]);
  });

  it('survives a timeout whose request lands at the provider AFTER the caller gave up: one preapproval, adopted later', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold({ completeLate: true });

    const timedOut = await org.checkout();
    // The caller gave up, the provider knows nothing yet, and that proves nothing: no new request.
    const notYet = await org.checkout();
    expect(await heldBy(org)).toHaveLength(0);
    slow.release();
    await Promise.resolve();

    expect(timedOut.statusCode).toBe(503);
    expect(notYet.statusCode).toBe(409);
    expect(await heldBy(org)).toHaveLength(1);
    world.advance(SETTLE_MS + 30_000);
    const adopted = await org.checkout();
    expect(adopted.statusCode, adopted.body).toBe(200);
    expect(await heldBy(org)).toHaveLength(1);
  });

  it('releases an attempt that never landed only after the settle window, then sends a new one with a reference of its own', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold();

    const timedOut = await org.checkout();
    slow.release();
    expect(timedOut.statusCode).toBe(503);
    expect(await heldBy(org)).toHaveLength(0);

    // Inside the window: "nothing was created" is not believed.
    const early = await org.checkout();
    expect(early.statusCode).toBe(409);

    world.advance(SETTLE_MS + 30_000);
    const later = await org.checkout();

    expect(later.statusCode, later.body).toBe(200);
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({
        state: 'released',
        external_reference: endingIn(/:1$/),
      }),
      expect.objectContaining({
        state: 'confirmed',
        external_reference: endingIn(/:2$/),
      }),
    ]);
    expect(await heldBy(org)).toHaveLength(1);
  });

  it('parks the subscription when the provider holds more than one preapproval that could be ours: it picks none', async () => {
    const org = await world.organization();
    await provider.setMode('lose_answer');
    await org.checkout();
    const [attempt] = await org.rows('subscription_attempt');
    // A resend by a provider that does not honour the key: a second one, equal in every field.
    await provider.gateway.createPreapproval(
      {
        externalReference: String(attempt?.['external_reference']),
        payerEmail: String(attempt?.['payer_email']),
        reason: 'Plan Profesional',
        amountCents: Number(attempt?.['amount_cents']),
        currency: 'ARS',
        backUrl: 'https://clinica.consultorio.test/subscription',
      },
      'a-resend-with-the-same-key',
    );
    world.advance(SETTLE_MS + 30_000);

    const response = await org.checkout();

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'subscription_needs_attention' });
    expect(await heldBy(org)).toHaveLength(2);
    expect(await org.subscription()).toMatchObject({
      attention_reason: 'ambiguous_preapproval',
      provider_preapproval_id: null,
      status: 'trial',
    });
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({ state: 'parked' }),
    ]);
    // Parked is parked: nothing more is sent for it, however many times it is asked.
    expect((await org.checkout()).statusCode).toBe(409);
    expect(await heldBy(org)).toHaveLength(2);
    expect(
      (await org.view()).json<{ subscription: { needsAttention: boolean } }>().subscription
        .needsAttention,
    ).toBe(true);
  });

  it('parks it when the one it holds is not what was asked: another payer, another amount', async () => {
    const org = await world.organization();
    const sub = await org.subscription();
    const reference = `sub:${String(sub['id'])}:1`;
    await org.run(
      sql`insert into subscription_attempt (tenant_id, subscription_id, kind, external_reference,
              idempotency_key, amount_cents, payer_email, state, outcome_unknown, marked_at, settle_until)
          values (${org.tenant.id}, ${String(sub['id'])}, 'preapproval', ${reference}, 'k-mismatch-1',
                  1800000, 'duena@clinica.example', 'marked', true,
                  ${new Date(world.clock.now.getTime() - 3_600_000).toISOString()},
                  ${new Date(world.clock.now.getTime() - 3_000_000).toISOString()})`,
    );
    await provider.gateway.createPreapproval(
      {
        externalReference: reference,
        payerEmail: 'otra.persona@example.test',
        reason: 'Plan de otra persona',
        amountCents: 9_900_000,
        currency: 'ARS',
        backUrl: 'https://clinica.consultorio.test/subscription',
      },
      'another-key',
    );

    const response = await org.checkout();

    expect(response.statusCode).toBe(409);
    expect(await org.subscription()).toMatchObject({
      attention_reason: 'identity_mismatch',
      provider_preapproval_id: null,
    });
  });
});

describe('an outage of the provider changes nothing (task 6.17)', () => {
  it('keeps the state while the provider is down on the renewal date, and reconciles after it recovers', async () => {
    const org = await world.organization();
    await org.checkout();
    const [held] = await heldBy(org);
    await provider.authorize(held?.preapprovalId ?? '');
    const before = await org.subscription();

    await provider.setMode('down');
    const during = await reconcile(org);
    await provider.setMode('ok');

    expect(during.outcome).toBe('unavailable');
    const mid = await org.subscription();
    expect(mid).toMatchObject({ status: 'trial', authorization_state: 'pending' });
    expect(mid['last_reconciled_at']).toEqual(before['last_reconciled_at']);

    const after = await reconcile(org);
    expect(after).toMatchObject({ outcome: 'done', from: 'trial', to: 'active' });
  });

  it('fails starting a subscription during an outage with a message that can be retried, and keeps the trial', async () => {
    const org = await world.organization();
    await provider.setMode('down');

    const response = await org.checkout();
    await provider.setMode('ok');

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'subscription_payments_unavailable' });
    expect(await org.subscription()).toMatchObject({
      status: 'trial',
      authorization_state: 'none',
    });
  });
});

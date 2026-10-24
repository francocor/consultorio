import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { startCheckout } from '../../src/modules/subscriptions/application/checkout.js';
import { runDunningStep, runTrialEnd } from '../../src/modules/subscriptions/application/clock.js';
import { requestCancellation } from '../../src/modules/subscriptions/application/management.js';
import { resolveParked } from '../../src/modules/subscriptions/application/parked.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { refundPayment } from '../../src/modules/subscriptions/application/refunds.js';
import {
  createSubscriptionJobs,
  SUBSCRIPTION_RECONCILE_JOB,
} from '../../src/modules/subscriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { listTenantIds } from '../../src/platform/jobs/tenant-scan.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';

/**
 * A subscription parked for a person has a way out, and it never blocks the end of an organization
 * (JD-S6 R1, C1); a cancelled organization stays cancelled (S6-2); the clocks hold where there is no
 * provider (B-T3); and "the window has passed" is judged as of the moment the provider was asked, never
 * later (S6-13). All against a provider that is NOT idempotent and whose requests can land late.
 */

/** A matcher for part of an object, typed so that the linter sees no `any`. */
const containing = (value: Record<string, unknown>): unknown => expect.objectContaining(value);

let runtime: DbHandle;
let world: SubscriptionWorld;
let provider: FakeHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const SETTLE_MS = 60_000;
const TIMEOUT_MS = 400;
const DAY = 86_400_000;

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

const actorOf = (org: SubscriptionOrganization) => ({
  userId: org.owner.user.id,
  actingRole: 'owner' as const,
  ip: null,
  userAgent: null,
  requestId: null,
});

const checkout = (org: SubscriptionOrganization) =>
  startCheckout(world.deps, {
    tenantId: org.tenant.id,
    userId: org.owner.user.id,
    actor: actorOf(org),
  });

const owner = (org: SubscriptionOrganization) => ({
  tenantId: org.tenant.id,
  userId: org.owner.user.id,
  actor: actorOf(org),
});

async function heldBy(org: SubscriptionOrganization) {
  const id = String((await org.subscription())['id']);
  return provider.fake
    .preapprovals()
    .filter((entry) => entry.externalReference.startsWith(`sub:${id}:`));
}
const liveOf = async (org: SubscriptionOrganization) =>
  (await heldBy(org)).filter((entry) => entry.status !== 'cancelled');

const auditOf = (org: SubscriptionOrganization, action: string) =>
  org.run(sql`select metadata, reason from audit_event where action = ${action} order by id`);

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

/**
 * A subscription parked because the provider holds two preapprovals that could be ours: the answer to
 * the first request was lost, and a resend that the provider did not recognize landed too.
 */
async function ambiguous() {
  const org = await world.organization();
  await provider.setMode('lose_answer');
  expect((await checkout(org)).status).toBe('unavailable');
  await provider.setMode('ok');
  const [only] = await heldBy(org);
  if (!only) throw new Error('the first request did not land');
  const resent = await provider.gateway.createPreapproval(
    {
      externalReference: only.externalReference,
      payerEmail: only.payerEmail,
      reason: 'Plan Estandar - 1 profesional',
      amountCents: only.amountCents,
      currency: 'ARS',
      backUrl: 'https://example.invalid/subscription',
    },
    'a-resend-with-another-key',
  );
  expect(resent.status).toBe('created');
  world.advance(SETTLE_MS + TIMEOUT_MS + 1_000);
  await reconcile(org);
  expect(await org.subscription()).toMatchObject({ attention_reason: 'ambiguous_preapproval' });
  expect(await liveOf(org)).toHaveLength(2);
  return org;
}

describe('a parked subscription can be cancelled, and cancelling it stops every preapproval (JD-S6 R1, C1)', () => {
  it('cancels both candidates it was parked for, looked up by the reference it asked with, and then ends', async () => {
    const org = await ambiguous();

    const outcome = await requestCancellation(world.deps, owner(org));

    expect(outcome.status).toBe('cancelling');
    // Nothing is left alive at the provider, and the platform knows it.
    expect(await liveOf(org)).toHaveLength(0);
    expect(await org.subscription()).toMatchObject({
      status: 'cancelling',
      authorization_state: 'none',
    });
    // Time passes; the end of the paid period ends the subscription and announces it.
    world.advance(20 * DAY);
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');
    expect(await org.subscription()).toMatchObject({ status: 'cancelled' });
    expect(world.cancelled.map((event) => event.tenantId)).toContain(org.tenant.id);
    expect(await liveOf(org)).toHaveLength(0);
  });
});

describe('a cancelling subscription with a parked creation reaches the end (JD-S6 R2, B-W3)', () => {
  it('sweeps what the parked request left at the provider at the end of the period, even with no authorization recorded', async () => {
    const org = await ambiguous();
    // The provider is down when the owner cancels: the sweep cannot run, the cancellation is requested.
    await provider.setMode('down');
    expect((await requestCancellation(world.deps, owner(org))).status).toBe('cancelling');
    await provider.setMode('ok');
    expect(await org.subscription()).toMatchObject({
      status: 'cancelling',
      authorization_state: 'none',
    });
    expect(await liveOf(org)).toHaveLength(2);

    world.advance(20 * DAY);
    const ended = await runDunningStep(world.deps, org.tenant.id);

    expect(ended).toBe('done');
    expect(await org.subscription()).toMatchObject({ status: 'cancelled' });
    expect(await liveOf(org)).toHaveLength(0);
  });
});

describe('the end of the paid period never cancels a subscription the provider may still charge (JD-S6 R1, C1)', () => {
  it('waits while the provider cannot confirm the cancellation, and ends once it has', async () => {
    const { org } = await subscribed();
    await provider.setMode('down');
    expect((await requestCancellation(world.deps, owner(org))).status).toBe('cancelling');
    expect(await org.subscription()).toMatchObject({
      status: 'cancelling',
      authorization_state: 'authorized',
    });

    world.advance(40 * DAY);
    const stuck = await runDunningStep(world.deps, org.tenant.id);

    expect(stuck).toBe('unavailable');
    expect(await org.subscription()).toMatchObject({ status: 'cancelling' });
    expect(world.cancelled.map((event) => event.tenantId)).not.toContain(org.tenant.id);
    expect(await liveOf(org)).toHaveLength(1);

    await provider.setMode('ok');
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');
    expect(await org.subscription()).toMatchObject({
      status: 'cancelled',
      authorization_state: 'none',
    });
    expect(await liveOf(org)).toHaveLength(0);
  });

  it('waits while a cancellation lands late, even once its time has passed, and ends when it is known', async () => {
    const { org } = await subscribed();
    const slow = provider.fake.hold({ completeLate: true });
    // The cancellation is held at the provider and the caller gives up on it.
    expect((await requestCancellation(world.deps, owner(org))).status).toBe('cancelling');
    expect(await org.rows('subscription_attempt')).toEqual(
      expect.arrayContaining([
        containing({ kind: 'cancel', state: 'marked', outcome_unknown: true }),
      ]),
    );

    world.advance(40 * DAY);
    // Its window is over, the provider still holds a live preapproval, and the new try is held too.
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('unavailable');
    expect(await org.subscription()).toMatchObject({ status: 'cancelling' });
    expect(await liveOf(org)).toHaveLength(1);

    // Both requests land now, late.
    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await liveOf(org)).toHaveLength(0);
    world.advance(SETTLE_MS + TIMEOUT_MS + 1_000);

    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');
    expect(await org.subscription()).toMatchObject({
      status: 'cancelled',
      authorization_state: 'none',
    });
  });

  it('ends a trial that was cancelled before anybody subscribed, with no provider to ask', async () => {
    const org = await world.organization();
    expect((await requestCancellation(world.deps, owner(org))).status).toBe('cancelling');
    world.advance(20 * DAY);

    const bare = { ...world.deps, adapters: undefined };

    expect(await runDunningStep(bare, org.tenant.id)).toBe('done');
    expect(await org.subscription()).toMatchObject({ status: 'cancelled' });
  });
});

describe('the operator lets a parked subscription go (JD-S6 R1, C1)', () => {
  it('releases what was parked, clears the cause, says who and why, and the reconcile stops what the provider holds', async () => {
    const org = await ambiguous();
    const operator = {
      userId: '0192f3a0-6b2c-7000-8000-0000000000aa',
      actingRole: null,
      ip: null,
      userAgent: null,
      requestId: null,
    };

    const outcome = await resolveParked(world.deps, { tenantId: org.tenant.id, actor: operator });

    expect(outcome).toEqual({
      status: 'resolved',
      was: 'ambiguous_preapproval',
      released: 1,
      reopened: 0,
    });
    expect(await org.subscription()).toMatchObject({ attention_reason: null, attention_at: null });
    expect(await org.rows('subscription_attempt')).toEqual([
      containing({
        kind: 'preapproval',
        state: 'released',
        message: 'resolved_by_operator',
      }),
    ]);
    const entries = await auditOf(org, 'subscription.parked_resolved');
    expect(entries).toEqual([
      {
        metadata: containing({ attention: 'ambiguous_preapproval', released: 1 }),
        reason: 'operator_decision',
      },
    ]);
    expect(
      world.recorded.jobs.filter(
        (job) => job.name === SUBSCRIPTION_RECONCILE_JOB && job.payload.tenantId === org.tenant.id,
      ).length,
    ).toBeGreaterThan(0);

    // The platform starts again from what the provider confirms: both candidates are stopped...
    await reconcile(org);
    expect(await liveOf(org)).toHaveLength(0);
    expect(await auditOf(org, 'subscription.preapproval_cancelled')).toHaveLength(2);
    // ...and the owner can subscribe again: exactly one alive.
    expect((await checkout(org)).status).toBe('ready');
    expect(await liveOf(org)).toHaveLength(1);
  });

  /** A refund the platform could not tell the outcome of, parked for a person. */
  async function withParkedRefund(refundedAtProvider: boolean) {
    const { org, first } = await subscribed();
    const charged = provider.fake.chargeCycle(first, 'approved');
    await reconcile(org);
    if (refundedAtProvider) {
      const sent = await provider.gateway.refund(
        { paymentId: charged.paymentId, amountCents: 500_000 },
        'a-key-the-platform-never-saw',
      );
      expect(sent.status).toBe('refunded');
    }
    await org.run(
      sql`insert into subscription_attempt (tenant_id, subscription_id, kind, external_reference,
              idempotency_key, amount_cents, payment_id, refund_ids_before, state, message,
              marked_at, settle_until)
            select current_setting('app.tenant_id')::uuid, s.id, 'refund',
                   'refund:' || s.id || ':' || ${charged.paymentId} || ':parked',
                   'parked-' || gen_random_uuid(), 500000, ${charged.paymentId}, '[]'::jsonb,
                   'parked', 'unexpected_state', ${clock.now.toISOString()}::timestamptz,
                   ${clock.now.toISOString()}::timestamptz
              from subscription s`,
    );
    await org.run(
      sql`update subscription set attention_reason = 'unexpected_state', attention_at = now()`,
    );
    return { org, charged };
  }
  const refundAttempts = async (org: SubscriptionOrganization) =>
    (await org.rows('subscription_attempt')).filter((row) => row['kind'] === 'refund');
  const operatorActor = {
    userId: '0192f3a0-6b2c-7000-8000-0000000000aa',
    actingRole: null,
    ip: null,
    userAgent: null,
    requestId: null,
  };

  it('does not release a parked refund that may have moved money: the provider is asked, and the refund that landed is adopted, never sent again (JD-S6 R2-4)', async () => {
    const { org, charged } = await withParkedRefund(true);

    const outcome = await resolveParked(world.deps, {
      tenantId: org.tenant.id,
      actor: operatorActor,
    });

    expect(outcome).toEqual({
      status: 'resolved',
      was: 'unexpected_state',
      released: 0,
      reopened: 1,
    });
    const [attempt] = await refundAttempts(org);
    expect(attempt).toMatchObject({ kind: 'refund', state: 'marked' });
    expect(attempt?.['resolved_at']).toBeNull();

    world.advance(SETTLE_MS + TIMEOUT_MS + 1_000);
    await reconcile(org);

    expect(await refundAttempts(org)).toEqual([containing({ state: 'confirmed' })]);
    expect(await org.rows('subscription_refund')).toHaveLength(1);
    expect(
      provider.fake.payments().find((p) => p.paymentId === charged.paymentId)?.refunds,
    ).toHaveLength(1);
  });

  it('keeps a parked refund blocking a new refund until the provider was asked, and releases it only when the provider holds nothing (JD-S6 R2-4)', async () => {
    const { org, charged } = await withParkedRefund(false);

    await resolveParked(world.deps, { tenantId: org.tenant.id, actor: operatorActor });
    const early = await refundPayment(world.deps, {
      tenantId: org.tenant.id,
      paymentId: String((await org.rows('subscription_payment'))[0]?.['id']),
      amountCents: 500_000,
      actor: operatorActor,
      requestedBy: 'operator',
      clientToken: 'a-new-token',
    });

    expect(early.status).toBe('in_progress');
    expect(
      provider.fake.payments().find((p) => p.paymentId === charged.paymentId)?.refunds,
    ).toHaveLength(0);

    world.advance(SETTLE_MS + TIMEOUT_MS + 1_000);
    await reconcile(org);

    expect(await refundAttempts(org)).toEqual([containing({ state: 'released' })]);
    expect(await org.rows('subscription_refund')).toHaveLength(0);
  });

  it('says there is nothing to resolve when the subscription is not parked', async () => {
    const { org } = await subscribed();

    const outcome = await resolveParked(world.deps, {
      tenantId: org.tenant.id,
      actor: { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null },
    });

    expect(outcome).toEqual({ status: 'not_parked' });
  });
});

describe('a parked subscription does not freeze the dates when nothing is ambiguous (JD-S6 R1, C1)', () => {
  it('lets the trial end while the owner has to authorize an amount, and holds it while the provider is ambiguous', async () => {
    const waiting = await world.organization();
    await waiting.run(
      sql`update subscription set attention_reason = 'reauthorization_needed', attention_at = now()`,
    );
    const stuck = await world.organization();
    await stuck.run(
      sql`update subscription set attention_reason = 'ambiguous_preapproval', attention_at = now()`,
    );
    world.advance(20 * DAY);

    expect(await runTrialEnd(world.deps, waiting.tenant.id)).toBe('done');
    expect(await waiting.subscription()).toMatchObject({ status: 'past_due' });
    expect(await runTrialEnd(world.deps, stuck.tenant.id)).toBe('unavailable');
    expect(await stuck.subscription()).toMatchObject({ status: 'trial' });
  });
});

describe('a cancelled organization stays cancelled (JD-S6 R1, S6-2)', () => {
  it('is not given back by a date or by a payment, and the database refuses it too', async () => {
    const { org } = await subscribed();
    await org.run(sql`update tenant set status = 'cancelled'`);

    // A rejected charge moves the subscription; the organization stays as it is.
    world.advance(5 * DAY);
    provider.fake.chargeCycle((await heldBy(org))[0]?.preapprovalId ?? '', 'rejected');
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ status: 'past_due' });
    expect(await org.run(sql`select status from tenant`)).toEqual([{ status: 'cancelled' }]);

    // The dates skip a cancelled organization.
    world.advance(30 * DAY);
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('skipped');
    expect(await runTrialEnd(world.deps, org.tenant.id)).toBe('skipped');
    expect(await org.run(sql`select status from tenant`)).toEqual([{ status: 'cancelled' }]);

    for (const status of ['active', 'read_only']) {
      await expect(org.run(sql.raw(`update tenant set status = '${status}'`))).rejects.toThrow();
    }
  });
});

describe('a cancelled organization is still asked about (JD-S6 R3-4)', () => {
  it('keeps moving last_reconciled_at under the scheduled reconcile, so its reading never goes stale on its own', async () => {
    const { org } = await subscribed();
    expect((await requestCancellation(world.deps, owner(org))).status).toBe('cancelling');
    world.advance(20 * DAY);
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');
    await org.run(sql`update tenant set status = 'cancelled'`);
    const held = await org.subscription();
    expect(held).toMatchObject({ status: 'cancelled', authorization_state: 'none' });
    // The preapproval is never cleared: the reading would count this subscription for ever if the
    // reconcile did not keep touching it.
    expect(held['provider_preapproval_id']).not.toBeNull();

    // The clock of the reconcile lists every organization that is not an unconfirmed signup, and the
    // job runs in a cancelled one (`webhook` is allowed when the organization has ended).
    expect(await listTenantIds(runtime.db)).toContain(org.tenant.id);
    world.advance(2 * DAY);
    const result = await runJob(runtime.db, createSubscriptionJobs(world.deps).reconcile, {
      id: randomUUID(),
      name: SUBSCRIPTION_RECONCILE_JOB,
      data: { tenantId: org.tenant.id },
      enqueuedAt: world.clock.now,
      retryCount: 0,
    });

    expect(result).toEqual({ status: 'completed' });
    const after = await org.subscription();
    expect(new Date(String(after['last_reconciled_at'])).getTime()).toBe(world.clock.now.getTime());
  });
});

describe('without a payments provider the dates hold (JD-S6 R1, B-T3)', () => {
  it('does not end a trial or run a grace out toward read-only for a debt nobody can pay', async () => {
    const trial = await world.organization();
    const late = await world.organization();
    world.advance(20 * DAY);
    const off = { ...world.deps, adapters: undefined };

    // The trial ended, but with no provider nobody could have subscribed: nothing moves.
    expect(await runTrialEnd(off, trial.tenant.id)).toBe('unavailable');
    expect(await trial.subscription()).toMatchObject({ status: 'trial' });

    // With the provider the same organization does turn past due, then read-only.
    expect(await runTrialEnd(world.deps, late.tenant.id)).toBe('done');
    expect(await late.subscription()).toMatchObject({ status: 'past_due' });
    world.advance(30 * DAY);
    expect(await runDunningStep(off, late.tenant.id)).toBe('unavailable');
    expect(await late.subscription()).toMatchObject({ status: 'past_due' });
    expect(await late.run(sql`select status from tenant`)).toEqual([{ status: 'active' }]);
    expect(await runDunningStep(world.deps, late.tenant.id)).toBe('done');
    expect(await late.subscription()).toMatchObject({ status: 'read_only' });
  });
});

describe('"the window has passed" is judged as of when the provider was asked (JD-S6 R1, S6-13)', () => {
  it('keeps waiting when the window closes while the answer is being written: a request may have landed after the search', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold({ completeLate: true });
    expect((await checkout(org)).status).toBe('unavailable');
    const [attempt] = await org.rows('subscription_attempt');
    const settleUntil = new Date(String(attempt?.['settle_until']));
    expect(attempt).toMatchObject({ state: 'marked', outcome_unknown: true });

    // One second before the window ends the platform looks: nothing there. While the answer travels
    // the request lands and the clock passes the end of the window.
    world.clock.now = new Date(settleUntil.getTime() - 1_000);
    const original = provider.fake.findPreapprovalsByReference.bind(provider.fake);
    const search = vi
      .spyOn(provider.fake, 'findPreapprovalsByReference')
      .mockImplementationOnce(async (reference, signal) => {
        const stale = await original(reference, signal);
        slow.release();
        await new Promise((resolve) => setTimeout(resolve, 20));
        world.advance(5_000);
        return stale;
      });
    await reconcile(org);
    search.mockRestore();

    // Not released: sending again here would have made a second preapproval next to the one that landed.
    expect(await org.rows('subscription_attempt')).toEqual([containing({ state: 'marked' })]);
    expect(await heldBy(org)).toHaveLength(1);

    // The next look sees it and adopts it: one preapproval, ever.
    await reconcile(org);
    expect(await org.rows('subscription_attempt')).toEqual([containing({ state: 'confirmed' })]);
    expect(await heldBy(org)).toHaveLength(1);
  });

  it('counts the window from the instant the caller gave up, not from the mark', async () => {
    const org = await world.organization();
    const slow = provider.fake.hold({ completeLate: true });
    const original = provider.fake.createPreapproval.bind(provider.fake);
    // The request sits half a minute between its mark and its sending.
    const create = vi
      .spyOn(provider.fake, 'createPreapproval')
      .mockImplementationOnce((request, key, signal) => {
        world.advance(30_000);
        return original(request, key, signal);
      });

    expect((await checkout(org)).status).toBe('unavailable');
    create.mockRestore();
    slow.release();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [attempt] = await org.rows('subscription_attempt');
    const markedAt = new Date(String(attempt?.['marked_at'])).getTime();
    const settleUntil = new Date(String(attempt?.['settle_until'])).getTime();
    // The window follows the give-up (half a minute after the mark), not the mark.
    expect(settleUntil - markedAt).toBeGreaterThanOrEqual(30_000 + SETTLE_MS);
  });
});

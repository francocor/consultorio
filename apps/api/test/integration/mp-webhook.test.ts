import { CheckoutResponse, OperatorSubscriptionDto } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { deliveryKeyOf } from '../../src/adapters/mercadopago-fake/mp-signature.js';
import {
  deliver,
  paymentNotices,
  preapprovalNotice,
} from '../../src/adapters/mercadopago-local/notices.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { refundPayment } from '../../src/modules/subscriptions/application/refunds.js';
import {
  SUBSCRIPTION_RECONCILE_JOB,
  createSubscriptionJobs,
} from '../../src/modules/subscriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { BASE_DOMAIN } from '../support/app.js';
import { runPending } from '../support/jobs.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
} from '../support/operator.js';
import { localHarness, type LocalHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';

/**
 * The notices of the payments provider and the local Mercado Pago end to end (tasks 6.13, 6.15 to
 * 6.17): the webhook checks the signature of the raw body and its window, records the event id once and
 * only queues a reconcile; the hosted page decides what the payer does and posts its notices to the
 * real webhook; a second approved payment of a period is a surplus; a refund is an entry of its own.
 */

let runtime: DbHandle;
let operators: OperatorHarness;
let world: SubscriptionWorld;
let provider: LocalHarness;
let operatorCookie: string;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const SECRET = 'a-secret-that-only-this-test-knows-0123456789';
const PLATFORM_HOST = `platform.${BASE_DOMAIN}`;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operators = createOperatorHarness();
  provider = localHarness(runtime, { clock, secret: SECRET, hostedCheckout: true });
  world = await createSubscriptionWorld(runtime, {
    harness: provider,
    clock,
    app: { operator: { database: operators.db, secrets: operators.secrets } },
  });
  operatorCookie = await operatorSession(
    world.app,
    await operators.addOperator(),
    createTestClock(clock.now),
  );
});

afterAll(async () => {
  await world.stop();
  await operators.close();
  await runtime.close();
});

const jobs = () => createSubscriptionJobs(world.deps).definitions;
const runJobs = () => runPending(runtime.db, world.recorded, jobs());
const queuedFor = (org: SubscriptionOrganization) =>
  world.recorded.jobs.filter(
    (job) => job.name === SUBSCRIPTION_RECONCILE_JOB && job.payload.tenantId === org.tenant.id,
  );
const eventsOf = (org: SubscriptionOrganization) => org.rows('subscription_event');

const noticeBody = (eventId: string, type: string, resourceId: string) =>
  JSON.stringify({ id: eventId, type, action: 'updated', data: { id: resourceId } });

let events = 0;
const nextEvent = () => `evt-${String(Date.now())}-${String((events += 1))}`;

/** An organization with a preapproval the payer already authorized and the platform knows. */
async function subscribed(): Promise<{ org: SubscriptionOrganization; preapprovalId: string }> {
  const org = await world.organization();
  const response = await org.checkout();
  expect(response.statusCode, response.body).toBe(200);
  const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
  await provider.authorize(preapprovalId);
  await reconcileSubscription(world.deps, org.tenant.id);
  expect(await org.subscription()).toMatchObject({ status: 'active' });
  return { org, preapprovalId };
}

describe('the webhook refuses what is not the provider and changes nothing (task 6.15)', () => {
  it('answers one generic refusal to a forged, altered, unsigned and stale notice, and records and queues nothing', async () => {
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    const body = noticeBody(nextEvent(), 'subscription_preapproval', preapprovalId);
    const signed = await world.notice(body);
    const queuedBefore = queuedFor(org).length;

    const forged = await world.post({
      rawBody: body,
      headers: {
        ...signed.headers,
        'x-signature': `ts=${String(clock.now.getTime())},v1=${'0'.repeat(64)}`,
      },
    });
    const altered = await world.post({
      rawBody: body.replace(preapprovalId, 'PRE-000000000000'),
      headers: signed.headers,
    });
    const unsigned = await world.post({ rawBody: body, headers: {} });
    const stale = await world.post(
      await world.notice(
        noticeBody(nextEvent(), 'subscription_preapproval', preapprovalId),
        clock.now.getTime() - 60 * 60_000,
      ),
    );

    expect([forged, altered, unsigned, stale].map((response) => response.statusCode)).toEqual([
      401, 401, 401, 401,
    ]);
    expect(
      new Set(
        [forged, altered, unsigned, stale].map(
          (response) => response.json<{ code: string }>().code,
        ),
      ),
    ).toEqual(new Set(['unauthenticated']));
    expect(await eventsOf(org)).toEqual([]);
    expect(queuedFor(org)).toHaveLength(queuedBefore);
  });

  it('records a signed notice once and queues a reconcile; the state is whatever the provider answers when asked', async () => {
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    const request = await world.notice(
      noticeBody(nextEvent(), 'subscription_preapproval', preapprovalId),
    );
    const eventId = deliveryKeyOf({
      id: preapprovalId,
      requestId: request.headers['x-request-id'] ?? '',
      ts: Number(/ts=(\d+)/.exec(request.headers['x-signature'] ?? '')?.[1]),
    });
    const accepted = await world.post(request);

    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toEqual({ accepted: true });
    expect(await eventsOf(org)).toEqual([
      expect.objectContaining({
        event_id: eventId,
        topic: 'preapproval',
        resource_id: preapprovalId,
      }),
    ]);
    expect(queuedFor(org)).toHaveLength(1);
    // Nothing moved because of the notice: the reconcile asks, and the provider says "pending".
    await runJobs();
    expect(await org.subscription()).toMatchObject({ status: 'trial' });
    // The payer authorizes; another notice; the reconcile writes what the provider says.
    await provider.authorize(preapprovalId);
    await world.post(
      await world.notice(noticeBody(nextEvent(), 'subscription_preapproval', preapprovalId)),
    );
    await runJobs();
    expect(await org.subscription()).toMatchObject({
      status: 'active',
      authorization_state: 'authorized',
    });
  });

  it('does nothing for a notice delivered twice: one record, one job', async () => {
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    const request = await world.notice(
      noticeBody(nextEvent(), 'subscription_preapproval', preapprovalId),
    );

    const first = await world.post(request);
    const second = await world.post(request);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(await eventsOf(org)).toHaveLength(1);
    expect(queuedFor(org)).toHaveLength(1);
  });

  it('keys a delivery by what the provider signed: a replay with another body id cannot take the key of the next delivery (JD-S6 R1, S6-9)', async () => {
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    const captured = await world.notice(
      noticeBody('evt-captured', 'subscription_preapproval', preapprovalId),
    );
    expect((await world.post(captured)).statusCode).toBe(200);
    expect(await eventsOf(org)).toHaveLength(1);

    // An attacker holding the captured request changes the id of the body, which the signature does
    // not cover, to the id the next real delivery will carry.
    const replay = {
      headers: captured.headers,
      rawBody: captured.rawBody.replace('evt-captured', 'evt-next-real'),
    };
    expect((await world.post(replay)).statusCode).toBe(200);
    expect(await eventsOf(org)).toHaveLength(1);

    // The next real delivery (another request id) is a delivery of its own: it is recorded and queued.
    world.advance(1_000);
    const real = await world.notice(
      noticeBody('evt-next-real', 'subscription_preapproval', preapprovalId),
    );
    expect((await world.post(real)).statusCode).toBe(200);
    expect(await eventsOf(org)).toHaveLength(2);
  });

  it('purges the notices that are older than a month with the reconcile, and keeps the recent ones (JD-S6 R1, S6-9)', async () => {
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    await org.run(sql`
      insert into subscription_event (tenant_id, event_id, topic, resource_id, signed_at, received_at)
      values (current_setting('app.tenant_id')::uuid, 'old-1', 'preapproval', 'PRE-OLD',
              now() - interval '40 days', now() - interval '40 days'),
             (current_setting('app.tenant_id')::uuid, 'recent-1', 'preapproval', 'PRE-RECENT',
              now() - interval '2 days', now() - interval '2 days')`);

    await reconcileSubscription(world.deps, org.tenant.id);

    const left = (await eventsOf(org)).map((row) => row['event_id']);
    expect(left).toContain('recent-1');
    expect(left).not.toContain('old-1');
    expect(preapprovalId).toBeTruthy();
  });

  it('acknowledges a notice about something no subscription holds, with the same answer and no trace', async () => {
    const before = world.recorded.jobs.length;

    const unknown = await world.post(
      await world.notice(noticeBody(nextEvent(), 'subscription_preapproval', 'PRE-NOT-OURS')),
    );
    const unknownPayment = await world.post(
      await world.notice(noticeBody(nextEvent(), 'payment', 'PAY-NOT-OURS')),
    );

    expect([unknown.statusCode, unknownPayment.statusCode]).toEqual([200, 200]);
    expect(unknown.json()).toEqual({ accepted: true });
    expect(world.recorded.jobs.length).toBe(before);
  });

  it('is accepted in a read-only organization: paying is how it recovers', async () => {
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    await org.run(sql`update tenant set status = 'read_only', read_only_since = now()`);

    const response = await world.post(
      await world.notice(noticeBody(nextEvent(), 'subscription_preapproval', preapprovalId)),
    );

    expect(response.statusCode).toBe(200);
    expect(queuedFor(org)).toHaveLength(1);
  });

  it('finds the organization of a payment the platform has not recorded yet, by asking the provider', async () => {
    const { org, preapprovalId } = await subscribed();
    const charged = await provider.controls.charge(preapprovalId, 'approved');
    const paymentId = charged?.paymentId ?? '';

    const response = await world.post(
      await world.notice(noticeBody(nextEvent(), 'payment', paymentId)),
    );

    expect(response.statusCode).toBe(200);
    expect(queuedFor(org)).toHaveLength(1);
  });

  it('does not reveal the organization: the answer of a known and an unknown resource is the same', async () => {
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);

    const known = await world.post(
      await world.notice(noticeBody(nextEvent(), 'subscription_preapproval', preapprovalId)),
    );
    const unknown = await world.post(
      await world.notice(noticeBody(nextEvent(), 'subscription_preapproval', 'PRE-OTHER')),
    );

    expect(known.json()).toEqual(unknown.json());
    expect(known.headers['content-type']).toBe(unknown.headers['content-type']);
  });
});

describe('the hosted page of the local Mercado Pago decides what the payer does (task 6.13)', () => {
  const pageOf = (checkoutUrl: string) => new URL(checkoutUrl).pathname.replace(/^\/api/, '');
  const open = (path: string) =>
    world.app.inject({ method: 'GET', url: path, headers: { host: PLATFORM_HOST } });
  const choose = (path: string, choice: string) =>
    world.app.inject({
      method: 'POST',
      url: path,
      headers: { host: PLATFORM_HOST, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `choice=${choice}`,
      remoteAddress: '10.99.0.3',
    });
  /** Where the page takes the payer back to: the address its `refresh` points at. */
  const returnAddress = (response: { body: string }) => {
    const match = /http-equiv="refresh" content="0; url=([^"]+)"/.exec(response.body);
    expect(match, 'the page takes the payer back').not.toBeNull();
    return (match?.[1] ?? '').replaceAll('&amp;', '&');
  };

  it('says it is simulated, offers approve, reject, pending and abandon, and asks for no card', async () => {
    const org = await world.organization();
    const path = pageOf(CheckoutResponse.parse((await org.checkout()).json()).checkoutUrl);

    const page = await open(path);

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    for (const label of [
      'simulado',
      'Aprobar',
      'Rechazar',
      'Dejar pendiente',
      'Abandonar',
      '18.000,00',
    ]) {
      expect(page.body, label).toContain(label);
    }
    expect(page.body.toLowerCase()).not.toMatch(/n[uú]mero de tarjeta|cvv|vencimiento/);
  });

  it('authorizes when the payer approves: it posts its notice to the real webhook and the reconcile activates', async () => {
    const org = await world.organization();
    const path = pageOf(CheckoutResponse.parse((await org.checkout()).json()).checkoutUrl);

    const done = await choose(path, 'approve');

    // A page that takes the payer back, not a redirect of the form: the policy of the page forbids it.
    expect(done.statusCode).toBe(200);
    expect(done.headers['content-security-policy']).toContain("form-action 'self'");
    expect(returnAddress(done)).toContain('/subscription?mp=approved');
    expect(new URL(returnAddress(done)).host).toBe(`${org.tenant.slug}.${BASE_DOMAIN}`);
    expect(done.body).toContain('Volver a la aplicación');
    expect(await eventsOf(org)).toHaveLength(1);
    expect(await org.subscription()).toMatchObject({ status: 'trial' });
    await runJobs();
    expect(await org.subscription()).toMatchObject({
      status: 'active',
      payment_method_label: 'Visa terminada en 4242',
    });
    // The page is done after that.
    expect((await open(path)).body).toContain('ya fue completada');
  });

  it('changes nothing when the payer abandons or leaves it pending; a rejection loses the authorization', async () => {
    const org = await world.organization();
    const path = pageOf(CheckoutResponse.parse((await org.checkout()).json()).checkoutUrl);

    const abandoned = await choose(path, 'abandon');
    const pending = await choose(path, 'pending');
    await runJobs();
    expect(returnAddress(abandoned)).toContain('mp=abandoned');
    expect(returnAddress(pending)).toContain('mp=pending');
    expect(await eventsOf(org)).toEqual([]);
    expect(await org.subscription()).toMatchObject({
      status: 'trial',
      authorization_state: 'pending',
    });

    const rejected = await choose(path, 'reject');
    await runJobs();
    expect(returnAddress(rejected)).toContain('mp=rejected');
    expect(await org.subscription()).toMatchObject({
      status: 'trial',
      authorization_state: 'lost',
    });
    // The owner can try again: the lost authorization is not a subscription.
    expect((await org.checkout()).statusCode).toBe(200);
  });

  it('refuses a choice that is not one of the four and a page that does not exist', async () => {
    const org = await world.organization();
    const path = pageOf(CheckoutResponse.parse((await org.checkout()).json()).checkoutUrl);

    expect((await choose(path, 'steal')).statusCode).toBe(400);
    expect(
      (await choose('/local-providers/mercadopago/checkout/PRE-NOPE', 'approve')).statusCode,
    ).toBe(404);
    expect((await open('/local-providers/mercadopago/checkout/PRE-NOPE')).statusCode).toBe(404);
  });

  it('does not serve the page when the provider console is off', async () => {
    const off = localHarness(runtime, { clock, secret: SECRET, hostedCheckout: false });
    const bare = await createSubscriptionWorld(runtime, { harness: off, clock });
    try {
      const response = await bare.app.inject({
        method: 'GET',
        url: '/local-providers/mercadopago/checkout/PRE-ANY',
        headers: { host: PLATFORM_HOST },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.stop();
    }
  });
});

describe('notices that arrive twice or backwards leave the same subscription (task 6.13)', () => {
  it('survives duplicate_events: each notice is recorded once and the payment is credited once', async () => {
    const { org, preapprovalId } = await subscribed();
    await provider.controls.setMode('duplicate_events');
    const charged = await provider.controls.charge(preapprovalId, 'approved');

    const accepted = await deliver(
      world.app,
      provider.local,
      'duplicate_events',
      paymentNotices(charged?.paymentId ?? ''),
    );
    await provider.controls.setMode('ok');
    await runJobs();

    expect(accepted).toBeGreaterThanOrEqual(2);
    const payments = await org.rows('subscription_payment');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ credited: true, surplus: false, period: '2026-10' });
    expect(new Set((await eventsOf(org)).map((row) => row['event_id'])).size).toBe(
      (await eventsOf(org)).length,
    );
  });

  it('survives out_of_order: the older notice after the newer one changes nothing', async () => {
    const { org, preapprovalId } = await subscribed();
    const charged = await provider.controls.charge(preapprovalId, 'approved');
    await deliver(
      world.app,
      provider.local,
      'out_of_order',
      paymentNotices(charged?.paymentId ?? ''),
    );
    await runJobs();
    const settled = await org.subscription();

    // The older notice arrives again, late: the provider is asked and says what it says now.
    await deliver(world.app, provider.local, 'ok', [preapprovalNotice(preapprovalId)]);
    await runJobs();

    expect(await org.rows('subscription_payment')).toHaveLength(1);
    const after = await org.subscription();
    expect(after['paid_through']).toEqual(settled['paid_through']);
    expect(after['version']).toBe(settled['version']);
    expect(after).toMatchObject({ status: 'active' });
  });
});

describe('a billing period is paid once (task 6.16)', () => {
  it('credits the first payment of the month: paid through the end of October', async () => {
    const { org, preapprovalId } = await subscribed();

    await provider.controls.charge(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);

    const [payment] = await org.rows('subscription_payment');
    expect(payment).toMatchObject({
      status: 'approved',
      credited: true,
      surplus: false,
      period: '2026-10',
      amount_cents: '1800000',
    });
    expect(new Date(String((await org.subscription())['paid_through'])).toISOString()).toBe(
      '2026-11-01T03:00:00.000Z',
    );
  });

  it('records a second approved payment for the same month as a surplus, flagged for the operator, and does not move paid through', async () => {
    const { org, preapprovalId } = await subscribed();
    await provider.controls.charge(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);
    const paidThrough = (await org.subscription())['paid_through'];
    const version = (await org.subscription())['version'];

    await provider.controls.charge(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);
    await reconcileSubscription(world.deps, org.tenant.id);

    const payments = await org.rows('subscription_payment');
    expect(payments).toHaveLength(2);
    expect(payments.filter((payment) => payment['surplus'] === true)).toHaveLength(1);
    expect(
      payments.filter((payment) => payment['credited'] === true && payment['surplus'] === false),
    ).toHaveLength(1);
    expect((await org.subscription())['paid_through']).toEqual(paidThrough);
    expect((await org.subscription())['version']).toBe(version);
    const audit = await org.run(
      sql`select metadata from audit_event where action = 'subscription.surplus_flagged'`,
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toMatch(/card|tarjeta/i);

    const response = await world.app.inject({
      method: 'GET',
      url: `/operator/tenants/${org.tenant.id}/subscription`,
      headers: platformHeaders(operatorCookie),
      remoteAddress: '10.96.8.5',
    });
    expect(OperatorSubscriptionDto.parse(response.json())).toMatchObject({ surplusFlags: 1 });
    expect(response.body).not.toMatch(/PAY-|payer|email/);
  });

  it('credits the next month when October is paid', async () => {
    const { org, preapprovalId } = await subscribed();
    await provider.controls.charge(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);

    world.advance(20 * 86_400_000);
    await provider.controls.charge(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);

    const payments = await org.rows('subscription_payment');
    expect(payments.map((payment) => [payment['period'], payment['surplus']]).sort()).toEqual([
      ['2026-10', false],
      ['2026-11', false],
    ]);
    expect(new Date(String((await org.subscription())['paid_through'])).toISOString()).toBe(
      '2026-12-01T03:00:00.000Z',
    );
    world.advance(-20 * 86_400_000);
  });
});

describe('an operator refund is an entry of its own (task 6.16)', () => {
  async function paid() {
    const { org, preapprovalId } = await subscribed();
    await provider.controls.charge(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);
    const [payment] = await org.rows('subscription_payment');
    if (!payment) throw new Error('no payment');
    return { org, payment, preapprovalId };
  }
  const operator = { userId: null, actingRole: null, ip: null, userAgent: null, requestId: null };

  it('gives part of a payment back: a refund entry, the payment keeps what it was, one audit entry', async () => {
    const { org, payment } = await paid();

    const outcome = await refundPayment(world.deps, {
      tenantId: org.tenant.id,
      paymentId: String(payment['id']),
      amountCents: 500_000,
      actor: operator,
      requestedBy: 'operator',
    });

    expect(outcome).toMatchObject({ status: 'refunded', amountCents: 500_000 });
    expect(await org.rows('subscription_refund')).toEqual([
      expect.objectContaining({ amount_cents: '500000', source: 'operator' }),
    ]);
    expect(await org.rows('subscription_payment')).toEqual([
      expect.objectContaining({
        status: 'partially_refunded',
        refunded_cents: '500000',
        amount_cents: '1800000',
      }),
    ]);
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({ kind: 'preapproval' }),
      expect.objectContaining({ kind: 'refund', state: 'confirmed' }),
    ]);
    expect(
      await org.run(sql`select 1 from audit_event where action = 'subscription.refunded'`),
    ).toHaveLength(1);
    // Reconciling afterwards adds no second entry for the same refund.
    await reconcileSubscription(world.deps, org.tenant.id);
    expect(await org.rows('subscription_refund')).toHaveLength(1);
  });

  it('refuses more than is left, or what is not approved, without calling the provider', async () => {
    const { org, payment } = await paid();

    const tooMuch = await refundPayment(world.deps, {
      tenantId: org.tenant.id,
      paymentId: String(payment['id']),
      amountCents: 1_800_001,
      actor: operator,
      requestedBy: 'operator',
    });
    const unknown = await refundPayment(world.deps, {
      tenantId: org.tenant.id,
      paymentId: '00000000-0000-0000-0000-000000000000',
      amountCents: 100,
      actor: operator,
      requestedBy: 'operator',
    });

    expect(tooMuch.status).toBe('not_refundable');
    expect(unknown.status).toBe('not_refundable');
    expect(await org.rows('subscription_refund')).toEqual([]);
  });

  it('does not send a refund again after an unknown outcome until the provider was asked: the lost answer is adopted', async () => {
    const { org, payment } = await paid();
    await provider.setMode('lose_answer');

    const lost = await refundPayment(world.deps, {
      tenantId: org.tenant.id,
      paymentId: String(payment['id']),
      amountCents: 400_000,
      actor: operator,
      requestedBy: 'operator',
    });
    const again = await refundPayment(world.deps, {
      tenantId: org.tenant.id,
      paymentId: String(payment['id']),
      amountCents: 400_000,
      actor: operator,
      requestedBy: 'operator',
    });

    expect(lost.status).toBe('unavailable');
    expect(again.status).toBe('in_progress');
    const held = await provider.gateway.getPayment(String(payment['provider_payment_id']));
    expect(held.status === 'found' ? held.payment.refunds : []).toHaveLength(1);

    world.advance(2 * 60_000);
    await reconcileSubscription(world.deps, org.tenant.id);

    expect(await org.rows('subscription_refund')).toEqual([
      expect.objectContaining({ amount_cents: '400000', source: 'operator' }),
    ]);
    expect(await org.rows('subscription_attempt')).toEqual([
      expect.objectContaining({ kind: 'preapproval' }),
      expect.objectContaining({ kind: 'refund', state: 'confirmed' }),
    ]);
    const once = await provider.gateway.getPayment(String(payment['provider_payment_id']));
    expect(once.status === 'found' ? once.payment.refundedCents : -1).toBe(400_000);
  });
});

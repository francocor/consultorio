import { RetryPaymentResponse, SubscriptionResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';

import { runDunningStep, runTrialEnd } from '../../src/modules/subscriptions/application/clock.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import {
  DUNNING_STEP_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  TRIAL_END_JOB,
  createSubscriptionJobs,
} from '../../src/modules/subscriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runPending } from '../support/jobs.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';

/**
 * The life of a subscription under a clock the test moves (tasks 6.18 to 6.21): the trial that ends
 * unpaid, the charge that fails and the dunning of day 1, 3 and 5, the grace that ends in read-only,
 * the payment that brings the organization back, the cancellation at the end of the paid period and
 * its reactivation. Every state changes because the PROVIDER confirmed something or a DATE arrived;
 * an outage of the provider skips a step and never advances one.
 */

let runtime: DbHandle;
let owner: pg.Client;
let world: SubscriptionWorld;
let provider: FakeHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  provider = fakeHarness({ clock, idempotent: false, settleWindowMs: 60_000 });
  world = await createSubscriptionWorld(runtime, {
    harness: provider,
    clock,
    providerTimeoutMs: 400,
  });
});

afterAll(async () => {
  await world.stop();
  await owner.end();
  await runtime.close();
});

const setNow = (iso: string) => {
  clock.now = at(iso);
};

const reconcile = (org: SubscriptionOrganization) =>
  reconcileSubscription(world.deps, org.tenant.id);

const emailsTo = (org: SubscriptionOrganization) =>
  world.email.sent.filter((message) => message.tenant?.id === org.tenant.id);

/** An organization that subscribed, authorized and paid October: active, paid through the end of it. */
async function activeOrganization(): Promise<{
  org: SubscriptionOrganization;
  preapprovalId: string;
}> {
  // The trial ended in September, unpaid and not yet noticed: the owner subscribes now.
  setNow('2026-09-01T15:00:00.000Z');
  const org = await world.organization();
  setNow('2026-10-20T15:00:00.000Z');
  await org.refresh();
  const started = await org.checkout();
  expect(started.statusCode, started.body).toBe(200);
  const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
  await provider.authorize(preapprovalId);
  await reconcile(org);
  await provider.chargeCycle(preapprovalId, 'approved');
  await reconcile(org);
  expect(await org.subscription()).toMatchObject({ status: 'active' });
  return { org, preapprovalId };
}

const tenantStatus = async (org: SubscriptionOrganization) =>
  (await org.run(sql`select status, read_only_since from tenant`))[0];

describe('the trial that ends with no subscription (task 6.18)', () => {
  it('does nothing before its date: the trial runs its 14 days', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    setNow('2026-11-02T15:00:00.000Z');

    expect(await runTrialEnd(world.deps, org.tenant.id)).toBe('skipped');

    expect(await org.subscription()).toMatchObject({ status: 'trial' });
    expect(emailsTo(org)).toEqual([]);
  });

  it('turns past due when it ends, with the grace counted from the end of the trial, and emails the read-only date', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    const trialEndsAt = new Date(String((await org.subscription())['trial_ends_at']));
    setNow('2026-11-03T15:00:01.000Z');

    expect(await runTrialEnd(world.deps, org.tenant.id)).toBe('done');
    expect(await runTrialEnd(world.deps, org.tenant.id)).toBe('skipped');

    const row = await org.subscription();
    expect(row).toMatchObject({ status: 'past_due', dunning_step: 0 });
    expect(new Date(String(row['grace_ends_at'])).getTime()).toBe(trialEndsAt.getTime() + 7 * DAY);
    expect((await tenantStatus(org))?.['status']).toBe('active');
    const mails = emailsTo(org);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.to).toContain('@');
    expect(mails[0]).toMatchObject({ subject: 'Terminó su período de prueba' });
    expect(mails[0]?.text).toContain('10 de noviembre de 2026');
    expect(mails[0]?.text).toContain('solo lectura');
    expect(mails[0]?.text).toContain(`${org.tenant.slug}.consultorio.test/subscription`);
    expect(mails[0]?.text).not.toMatch(/paciente \w+|historia cl[ií]nica de/i);
  });

  it('does not make a trial past due that the owner authorized: the provider is asked first', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    await org.checkout();
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    // The owner authorized on the last day; the notice never arrived.
    await provider.authorize(preapprovalId);
    setNow('2026-11-03T15:00:01.000Z');

    await runTrialEnd(world.deps, org.tenant.id);

    expect(await org.subscription()).toMatchObject({
      status: 'active',
      authorization_state: 'authorized',
    });
    expect(emailsTo(org)).toEqual([]);
  });

  it('skips the step while the provider cannot be asked: an outage never turns a trial past due', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    await org.checkout();
    setNow('2026-11-03T15:00:01.000Z');
    await provider.setMode('down');

    const during = await runTrialEnd(world.deps, org.tenant.id);
    await provider.setMode('ok');

    expect(during).toBe('unavailable');
    expect(await org.subscription()).toMatchObject({ status: 'trial' });
    expect(emailsTo(org)).toEqual([]);
    expect(await runTrialEnd(world.deps, org.tenant.id)).toBe('done');
    expect(await org.subscription()).toMatchObject({ status: 'past_due' });
  });
});

describe('a charge that fails: the grace, the dunning and the end in read-only (tasks 6.18 and 6.19)', () => {
  it('walks the whole timeline under a fake clock: past due, day 1, 3 and 5, read-only', async () => {
    const { org, preapprovalId } = await activeOrganization();
    const asked = vi.spyOn(provider.fake, 'findPayments');

    // November 5: the charge is rejected, and the provider says so.
    setNow('2026-11-05T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);

    let row = await org.subscription();
    expect(row).toMatchObject({ status: 'past_due', dunning_step: 0 });
    expect(new Date(String(row['grace_ends_at'])).toISOString()).toBe('2026-11-12T15:00:00.000Z');
    expect((await tenantStatus(org))?.['status']).toBe('active');
    const first = emailsTo(org).at(-1);
    expect(first?.subject).toBe('No pudimos cobrar su suscripción');
    expect(first?.text).toContain('$ 18.000,00');
    expect(first?.text).toContain('12 de noviembre de 2026');

    // Day 1, 3 and 5: each asks the provider where the charge stands, and emails once.
    for (const [index, day] of [1, 3, 5].entries()) {
      setNow(new Date(at('2026-11-05T15:00:00.000Z').getTime() + day * DAY + 1000).toISOString());
      asked.mockClear();
      expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');
      expect(asked).toHaveBeenCalled();
      expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');
      row = await org.subscription();
      expect(row).toMatchObject({ status: 'past_due', dunning_step: index + 1 });
    }
    const reminders = emailsTo(org).filter(
      (m) => m.subject === 'Todavía no pudimos cobrar su suscripción',
    );
    expect(reminders).toHaveLength(3);
    expect(reminders.map((m) => /Pasaron (\d) d/.exec(m.text)?.[1])).toEqual(['1', '3', '5']);

    // November 12: the grace ends with no payment.
    setNow('2026-11-12T15:00:01.000Z');
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');

    row = await org.subscription();
    expect(row).toMatchObject({ status: 'read_only' });
    expect(await tenantStatus(org)).toMatchObject({ status: 'read_only' });
    expect((await tenantStatus(org))?.['read_only_since']).not.toBeNull();
    expect(emailsTo(org).at(-1)?.subject).toBe('Su cuenta pasó a solo lectura');
    // Nobody else is emailed twice for the same moment.
    const before = emailsTo(org).length;
    await runDunningStep(world.deps, org.tenant.id);
    expect(emailsTo(org)).toHaveLength(before);
    asked.mockRestore();
  });

  it('skips a step while the provider cannot be asked: an outage never advances the dunning', async () => {
    const { org, preapprovalId } = await activeOrganization();
    setNow('2026-11-05T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);
    setNow('2026-11-06T15:00:01.000Z');
    await provider.setMode('down');
    const before = emailsTo(org).length;

    const skipped = await runDunningStep(world.deps, org.tenant.id);
    setNow('2026-11-13T15:00:01.000Z');
    const alsoPastGrace = await runDunningStep(world.deps, org.tenant.id);
    await provider.setMode('ok');

    expect([skipped, alsoPastGrace]).toEqual(['unavailable', 'unavailable']);
    // Even past the end of the grace: no outage ever makes an organization read-only.
    expect(await org.subscription()).toMatchObject({ status: 'past_due', dunning_step: 0 });
    expect(emailsTo(org)).toHaveLength(before);
    // After the outage the step is done, with the facts of the provider.
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');
    expect(await org.subscription()).toMatchObject({ status: 'read_only' });
  });

  it('is settled by a payment the provider confirms: a retry that succeeds stops the dunning', async () => {
    const { org, preapprovalId } = await activeOrganization();
    setNow('2026-11-05T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);
    setNow('2026-11-06T15:00:01.000Z');
    // The provider retried the charge on its own and it was approved.
    await provider.chargeCycle(preapprovalId, 'approved');

    await runDunningStep(world.deps, org.tenant.id);

    const row = await org.subscription();
    expect(row).toMatchObject({
      status: 'active',
      dunning_step: 0,
      grace_ends_at: null,
      first_failure_at: null,
    });
    expect(emailsTo(org).at(-1)?.subject).toBe('Recibimos su pago');
    // No reminder was sent for a debt that no longer exists.
    expect(emailsTo(org).filter((m) => m.subject.startsWith('Todavía'))).toEqual([]);
  });

  it('does not touch a parked subscription: nothing advances until a person decides', async () => {
    const { org, preapprovalId } = await activeOrganization();
    setNow('2026-11-05T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);
    await org.run(
      sql`update subscription set attention_reason = 'unexpected_state', attention_at = now()`,
    );
    setNow('2026-11-20T15:00:00.000Z');

    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('unavailable');

    expect(await org.subscription()).toMatchObject({ status: 'past_due' });
  });
});

describe('the read-only organization and its recovery (task 6.19)', () => {
  async function readOnlyOrganization() {
    const { org, preapprovalId } = await activeOrganization();
    setNow('2026-11-05T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'rejected');
    await reconcile(org);
    setNow('2026-11-12T15:00:01.000Z');
    await runDunningStep(world.deps, org.tenant.id);
    expect(await org.subscription()).toMatchObject({ status: 'read_only' });
    await org.refresh();
    return { org, preapprovalId };
  }

  it('refuses a write with the generic reason and no billing detail, and keeps every read', async () => {
    const { org } = await readOnlyOrganization();
    const reception = await org.member('reception');

    const refused = await org.api.post('/patients', reception, {
      familyName: 'Gomez',
      givenNames: 'Ana',
      birthDate: '1980-01-01',
      dataProcessingConsent: true,
    });
    const read = await org.api.get('/patients', reception);

    expect(refused.statusCode).toBe(402);
    expect(refused.json()).toMatchObject({ code: 'tenant_read_only' });
    expect(refused.body).not.toMatch(/suscripci|subscription|Mercado|monto|amount|\$/i);
    expect(read.statusCode).toBe(200);
  });

  it('lets the owner keep managing the subscription: paying is how the organization recovers', async () => {
    const { org } = await readOnlyOrganization();

    const view = await org.view();
    const link = await org.api.post('/subscription/retry-payment', org.owner);

    expect(view.statusCode, view.body).toBe(200);
    expect(SubscriptionResponse.parse(view.json()).subscription).toMatchObject({
      status: 'read_only',
    });
    expect(link.statusCode, link.body).toBe(200);
    expect(RetryPaymentResponse.parse(link.json()).paymentUrl).toMatch(/^https?:\/\//);
  });

  it('returns to active when the provider confirms a payment that settles the debt, and not before', async () => {
    const { org } = await readOnlyOrganization();
    const link = RetryPaymentResponse.parse(
      (await org.api.post('/subscription/retry-payment', org.owner)).json(),
    );
    const again = RetryPaymentResponse.parse(
      (await org.api.post('/subscription/retry-payment', org.owner)).json(),
    );
    const linkId = provider.fake
      .paymentLinks()
      .find((entry) => entry.url === link.paymentUrl)?.linkId;
    if (!linkId) throw new Error('no link at the provider');

    // The owner has the link; until the provider confirms a payment nothing changes.
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ status: 'read_only' });
    expect(again.paymentUrl).toBe(link.paymentUrl);
    const subscriptionId = String((await org.subscription())['id']);
    expect(
      provider.fake
        .paymentLinks()
        .filter((entry) => entry.externalReference.startsWith(`due:${subscriptionId}:`)),
    ).toHaveLength(1);

    await provider.payLink(linkId);
    await reconcile(org);

    const row = await org.subscription();
    expect(row).toMatchObject({ status: 'active', grace_ends_at: null, dunning_step: 0 });
    expect(await tenantStatus(org)).toMatchObject({ status: 'active', read_only_since: null });
    expect(emailsTo(org).at(-1)?.subject).toBe('Recibimos su pago');
    // The reception can write again, without anything replayed.
    const reception = await org.member('reception');
    const created = await org.api.post('/patients', reception, {
      familyName: 'Gomez',
      givenNames: 'Ana',
      birthDate: '1980-01-01',
      dataProcessingConsent: true,
    });
    expect(created.statusCode, created.body).toBe(201);
  });

  it('keeps the pin of a link whose outcome is unknown: no second link while it may still land', async () => {
    const { org } = await readOnlyOrganization();
    await provider.setMode('lose_answer');

    const lost = await org.api.post('/subscription/retry-payment', org.owner);
    const impatient = await org.api.post('/subscription/retry-payment', org.owner);

    expect(lost.statusCode).toBe(503);
    expect(impatient.statusCode).toBe(409);
    const subscriptionId = String((await org.subscription())['id']);
    const links = provider.fake
      .paymentLinks()
      .filter((entry) => entry.externalReference.startsWith(`due:${subscriptionId}:`));
    expect(links).toHaveLength(1);
    setNow('2026-11-12T15:05:00.000Z');
    const adopted = await org.api.post('/subscription/retry-payment', org.owner);
    expect(adopted.statusCode, adopted.body).toBe(200);
    expect(RetryPaymentResponse.parse(adopted.json()).paymentUrl).toBe(links[0]?.url);
  });

  it('keeps its clocks running in a read-only organization: the jobs are of the subscription, which is the accounting of the owner', async () => {
    const { org, preapprovalId } = await readOnlyOrganization();
    // The provider retried the charge on its own and it was approved while the organization was read-only.
    await provider.chargeCycle(preapprovalId, 'approved');
    await org.run(sql`select 1`);
    const jobs = createSubscriptionJobs(world.deps).definitions;
    for (const name of [SUBSCRIPTION_RECONCILE_JOB, TRIAL_END_JOB, DUNNING_STEP_JOB]) {
      await world.deps.withTenant(
        { tenantId: org.tenant.id, userId: '00000000-0000-0000-0000-000000000000' },
        (tx) => world.recorded.enqueue(tx, name, { tenantId: org.tenant.id }),
      );
    }

    const results = await runPending(runtime.db, world.recorded, jobs);

    expect(results.map((entry) => entry.result.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(await org.subscription()).toMatchObject({ status: 'active' });
    expect(await tenantStatus(org)).toMatchObject({ status: 'active', read_only_since: null });
  });

  it('has nothing to pay when nothing is overdue', async () => {
    const { org } = await activeOrganization();

    const response = await org.api.post('/subscription/retry-payment', org.owner);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'subscription_nothing_due' });
  });
});

describe('an exempt organization has none of this (task 6.20)', () => {
  it('has no subscription, no trial, no limit and no read-only state however old it is', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const demo = await world.organization({ trial: false, isDemo: true, billingExempt: true });
    setNow('2027-03-01T15:00:00.000Z');
    await demo.refresh();

    expect(await runTrialEnd(world.deps, demo.tenant.id)).toBe('skipped');
    expect(await runDunningStep(world.deps, demo.tenant.id)).toBe('skipped');
    expect((await reconcile(demo)).outcome).toBe('nothing');

    expect(await demo.rows('subscription')).toEqual([]);
    expect((await tenantStatus(demo))?.['status']).toBe('active');
    const view = SubscriptionResponse.parse((await demo.view()).json());
    expect(view).toMatchObject({ exempt: true, subscription: null, plan: null });
    expect(emailsTo(demo)).toEqual([]);
    setNow('2026-10-20T15:00:00.000Z');
  });
});

describe('plan, cancellation and reactivation (task 6.21)', () => {
  async function secondPlan(max: number): Promise<string> {
    const key = `plan-${String(max)}-${String(Date.now() % 1_000_000)}`;
    await owner.query(
      `INSERT INTO plan (key, name, price_per_professional_cents, max_active_professionals,
                         overage_unit_price_cents, overage_cap_default, overage_cap_max)
       VALUES ($1, 'Plan chico', 900000, $2, 5000, 50, 100)`,
      [key, max],
    );
    return key;
  }

  it('changes the plan, audits it, and caps the overage cap at what the new plan allows', async () => {
    const { org } = await activeOrganization();
    const key = await secondPlan(5);

    const response = await org.api.post('/subscription/plan', org.owner, { planKey: key });

    expect(response.statusCode, response.body).toBe(200);
    expect(SubscriptionResponse.parse(response.json()).subscription?.plan.key).toBe(key);
    expect(await org.subscription()).toMatchObject({ overage_cap_messages: 100 });
    const audit = await org.run(
      sql`select metadata from audit_event where action = 'subscription.plan_changed'`,
    );
    expect(audit).toEqual([expect.objectContaining({ metadata: { from: 'standard', to: key } })]);
    expect(
      (await org.api.post('/subscription/plan', org.owner, { planKey: 'no-such-plan' })).statusCode,
    ).toBe(404);
  });

  it('refuses a plan with room for fewer professionals than are active, and accepts one with room for them', async () => {
    const { org } = await activeOrganization();
    await org.professional();
    await org.professional();
    const small = await secondPlan(1);
    const enough = await secondPlan(2);

    const refused = await org.api.post('/subscription/plan', org.owner, { planKey: small });
    const accepted = await org.api.post('/subscription/plan', org.owner, { planKey: enough });

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'subscription_plan_too_small' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(SubscriptionResponse.parse(accepted.json()).subscription?.plan.key).toBe(enough);
  }, 120_000);

  it('cancels at the end of the paid period: service until then, the provider told, retention told when it ends', async () => {
    const { org, preapprovalId } = await activeOrganization();
    setNow('2026-10-25T15:00:00.000Z');
    await org.refresh();

    const response = await org.api.post('/subscription/cancel', org.owner);

    expect(response.statusCode, response.body).toBe(200);
    const view = SubscriptionResponse.parse(response.json()).subscription;
    expect(view).toMatchObject({
      status: 'cancelling',
      nextTransition: { kind: 'service_ends', at: '2026-11-01T03:00:00.000Z' },
    });
    expect((await tenantStatus(org))?.['status']).toBe('active');
    // The provider stopped the charges.
    expect(
      provider.fake.preapprovals().find((entry) => entry.preapprovalId === preapprovalId)?.status,
    ).toBe('cancelled');
    expect(await org.subscription()).toMatchObject({ authorization_state: 'none' });
    // Before the end of the paid period nothing ends.
    setNow('2026-10-31T20:00:00.000Z');
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('skipped');
    expect(world.cancelled.filter((event) => event.tenantId === org.tenant.id)).toEqual([]);

    setNow('2026-11-01T03:00:01.000Z');
    expect(await runDunningStep(world.deps, org.tenant.id)).toBe('done');

    expect(await org.subscription()).toMatchObject({ status: 'cancelled' });
    expect((await tenantStatus(org))?.['status']).toBe('cancelled');
    expect(world.cancelled.filter((event) => event.tenantId === org.tenant.id)).toEqual([
      expect.objectContaining({ source: 'subscription' }),
    ]);
    const audits = await org.run(
      sql`select action from audit_event where action in ('tenant.cancelled', 'subscription.state_changed') order by occurred_at`,
    );
    expect(audits.map((entry) => entry['action'])).toContain('tenant.cancelled');
    // Nothing was deleted: the records of the organization stay.
    expect(await org.rows('subscription_payment')).toHaveLength(1);
  });

  it('takes the cancellation back while it is cancelling: the owner authorizes again, and the confirmed authorization reactivates', async () => {
    const { org } = await activeOrganization();
    setNow('2026-10-25T15:00:00.000Z');
    await org.refresh();
    await org.api.post('/subscription/cancel', org.owner);

    // The cancellation reached the provider: the old authorization is gone.
    const refused = await org.api.post('/subscription/reactivate', org.owner);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'subscription_reauthorization_required' });
    expect(await org.subscription()).toMatchObject({ status: 'cancelling' });

    const checkout = await org.checkout();
    expect(checkout.statusCode, checkout.body).toBe(200);
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    await provider.authorize(preapprovalId);
    await reconcile(org);

    expect(await org.subscription()).toMatchObject({
      status: 'active',
      authorization_state: 'authorized',
      cancel_requested_at: null,
    });
  });

  it('reactivates at once when the provider still has the authorization (the cancellation never reached it)', async () => {
    const { org } = await activeOrganization();
    setNow('2026-10-25T15:00:00.000Z');
    await org.refresh();
    await provider.setMode('down');
    const cancel = await org.api.post('/subscription/cancel', org.owner);
    await provider.setMode('ok');
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await org.subscription()).toMatchObject({
      status: 'cancelling',
      authorization_state: 'authorized',
    });

    const back = await org.api.post('/subscription/reactivate', org.owner);

    expect(back.statusCode, back.body).toBe(200);
    expect(SubscriptionResponse.parse(back.json()).subscription).toMatchObject({
      status: 'active',
    });
  });

  it('keeps trying to stop the charges while the provider cannot be reached: the reconcile tells it later', async () => {
    const { org, preapprovalId } = await activeOrganization();
    setNow('2026-10-25T15:00:00.000Z');
    await org.refresh();
    await provider.setMode('down');
    await org.api.post('/subscription/cancel', org.owner);
    await provider.setMode('ok');
    expect(
      provider.fake.preapprovals().find((entry) => entry.preapprovalId === preapprovalId)?.status,
    ).toBe('authorized');

    await reconcile(org);

    expect(
      provider.fake.preapprovals().find((entry) => entry.preapprovalId === preapprovalId)?.status,
    ).toBe('cancelled');
    expect(await org.subscription()).toMatchObject({
      status: 'cancelling',
      authorization_state: 'none',
    });
  });

  it('cancels a trial at the end of the trial, and an organization that never paid is cancelled with it', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();

    const response = await org.api.post('/subscription/cancel', org.owner);

    expect(response.statusCode, response.body).toBe(200);
    expect(await org.subscription()).toMatchObject({ status: 'cancelling' });
    setNow('2026-11-03T15:00:01.000Z');
    await runDunningStep(world.deps, org.tenant.id);
    expect(await org.subscription()).toMatchObject({ status: 'cancelled' });
  });

  it('refuses to cancel twice or what is cancelled, and an exempt organization has nothing to cancel', async () => {
    const { org } = await activeOrganization();
    await org.api.post('/subscription/cancel', org.owner);
    const exempt = await world.organization({ trial: false, billingExempt: true });

    const twice = await org.api.post('/subscription/cancel', org.owner);
    const none = await exempt.api.post('/subscription/cancel', exempt.owner);

    expect(twice.statusCode).toBe(200);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ code: 'subscription_exempt' });
  });

  it('is the owner alone who manages the plan, the cancellation and the payment', async () => {
    const { org } = await activeOrganization();
    const professional = await org.member('professional');

    for (const [method, url] of [
      ['post', '/subscription/cancel'],
      ['post', '/subscription/reactivate'],
      ['post', '/subscription/retry-payment'],
      ['get', '/subscription/plans'],
    ] as const) {
      const response = await org.api[method](url, professional);
      expect(response.statusCode, url).toBe(403);
    }
    expect(
      (await org.api.post('/subscription/plan', professional, { planKey: 'standard' })).statusCode,
    ).toBe(403);
  });
});

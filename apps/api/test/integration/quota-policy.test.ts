import {
  OperatorUsageResponse,
  SubscriptionUsageResponse,
  type SubscriptionUsageResponse as Usage,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { reserveWhatsappUsage } from '../../src/modules/notifications/application/usage.js';
import { createOperatorRun } from '../../src/modules/operator/index.js';
import { sendPendingNotices } from '../../src/modules/subscriptions/application/notices.js';
import { createQuotaPolicy } from '../../src/modules/subscriptions/application/quota-policy.js';
import { runUsageSnapshot } from '../../src/modules/subscriptions/application/usage.js';
import { subscriptionOperatorRoutes } from '../../src/modules/subscriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createOperatorHarness, type OperatorHarness } from '../support/operator.js';
import { fakeHarness, type FakeHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';
import {
  professionalIdOf,
  seedActiveDays,
  seedBareMessages,
  seedMessages,
} from '../support/usage-seed.js';

/**
 * The WhatsApp quota of the plan and the overage (tasks 6.25 to 6.28): the quota of each professional,
 * prorated by the days they were active; overage while the cap of the organization allows it; the
 * fall-back to email and the single notice when it does not; the cap the owner sets, and the counts the
 * operator reads. Everything counted is a count: no message text, no patient.
 */

let runtime: DbHandle;
let operatorSide: OperatorHarness;
let world: SubscriptionWorld;
let provider: FakeHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const setNow = (iso: string) => {
  clock.now = new Date(iso);
};
const quota = () => createQuotaPolicy({ clock: () => clock.now });

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  operatorSide = createOperatorHarness();
  provider = fakeHarness({ clock, idempotent: false });
  world = await createSubscriptionWorld(runtime, { harness: provider, clock });
});

afterAll(async () => {
  await world.stop();
  await operatorSide.close();
  await runtime.close();
});

const limitOf = (org: SubscriptionOrganization, professionalId: string, period = '2026-10') =>
  world.deps.withTenant({ tenantId: org.tenant.id, userId: org.owner.user.id }, (tx) =>
    quota().limitFor(tx, professionalId, period),
  );

const days = (period: string, from: number, to: number) =>
  Array.from(
    { length: to - from + 1 },
    (_, index) => `${period}-${String(from + index).padStart(2, '0')}`,
  );

/** An active subscription with one professional who has been active the whole month. */
async function active(options: { cap?: number; messages?: number } = {}) {
  setNow('2026-10-20T15:00:00.000Z');
  const org = await world.organization();
  const doctor = await org.professional();
  const professionalId = await professionalIdOf(org, doctor);
  await seedActiveDays(org, professionalId, days('2026-10', 1, 19));
  await org.run(sql`update subscription set status = 'active'`);
  if (options.cap !== undefined) {
    await org.run(sql`update subscription set overage_cap_messages = ${options.cap}`);
  }
  if (options.messages)
    await seedMessages(org, professionalId, options.messages, { period: '2026-10' });
  return { org, professionalId, doctor };
}

describe('the quota of a professional (task 6.26)', () => {
  it('has none where there is no billing: everything is allowed and still counted', async () => {
    const org = await world.organization({ billingExempt: true });
    const professionalId = await professionalIdOf(org, await org.professional());

    expect(await limitOf(org, professionalId)).toEqual({ limit: null, overageAllowed: true });
  });

  it('gives each active professional the quota of the plan for the month', async () => {
    const { org, professionalId } = await active();

    expect(await limitOf(org, professionalId)).toMatchObject({ limit: 200 });
  });

  it('prorates it by the days the professional was active, so one who left stops receiving quota', async () => {
    const { org, professionalId } = await active();
    // Active the first 10 days of the month, then deactivated.
    const other = await org.professional();
    const leaverId = await professionalIdOf(org, other);
    await seedActiveDays(org, leaverId, days('2026-10', 1, 10));
    await org.run(sql`update professional set status = 'inactive' where id = ${leaverId}`);

    // 10 of 31 days of 200 messages.
    expect((await limitOf(org, leaverId)).limit).toBe(65);
    expect((await limitOf(org, professionalId)).limit).toBe(200);
  });

  it('does not carry the unused quota over to the next month', async () => {
    const { org, professionalId } = await active({ messages: 10 });
    await seedActiveDays(org, professionalId, days('2026-11', 1, 30));
    setNow('2026-11-05T15:00:00.000Z');

    expect((await limitOf(org, professionalId, '2026-11')).limit).toBe(200);
    const usage = await world.deps.withTenant(
      { tenantId: org.tenant.id, userId: org.owner.user.id },
      (tx) =>
        tx.execute(
          sql`select count(*)::int as n from whatsapp_usage_event where period = '2026-11'`,
        ),
    );
    expect(usage.rows[0]).toMatchObject({ n: 0 });
  });

  it('allows overage while the cap is above zero and has not been reached', async () => {
    const { org, professionalId } = await active({ cap: 100, messages: 250 });

    expect(await limitOf(org, professionalId)).toEqual({ limit: 200, overageAllowed: true });
  });

  it('does not allow overage when it is off, and tells the owner once', async () => {
    const { org, professionalId } = await active({ cap: 0, messages: 200 });

    expect(await limitOf(org, professionalId)).toEqual({ limit: 200, overageAllowed: false });
    expect(await limitOf(org, professionalId)).toEqual({ limit: 200, overageAllowed: false });

    const notices = await org.rows('subscription_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'overage_cap_reached', key: '2026-10' });
    await sendPendingNotices(world.deps, org.tenant.id);
    await sendPendingNotices(world.deps, org.tenant.id);
    const mails = world.email.sent.filter(
      (message) =>
        message.tenant?.id === org.tenant.id &&
        message.subject === 'Se agotó la cuota de mensajes de WhatsApp',
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]?.text).toContain('correo electrónico');
    expect(mails[0]?.text).not.toMatch(/Apellido|Nombre/);
  });

  it('stops allowing overage the moment the cap is reached', async () => {
    const { org, professionalId } = await active({ cap: 50, messages: 249 });
    expect((await limitOf(org, professionalId)).overageAllowed).toBe(true);

    const [more] = await seedMessages(org, professionalId, 1, { period: '2026-10' });

    expect(more).toBeDefined();
    // 250 sent is 50 beyond the 200 of the quota: the cap of 50 is reached.
    expect(await limitOf(org, professionalId)).toEqual({ limit: 200, overageAllowed: false });
  });

  it('never allows overage during the trial: the days are free, the messages beyond the quota are not', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    const professionalId = await professionalIdOf(org, await org.professional());
    await seedMessages(org, professionalId, 201, { period: '2026-10' });

    // The professional started today: 12 of the 31 days of the month, 77 of the 200 messages.
    expect(await limitOf(org, professionalId)).toEqual({ limit: 77, overageAllowed: false });
  });

  it('does not count a message the provider refused, nor email', async () => {
    const { org, professionalId } = await active({ cap: 0, messages: 199 });
    await seedMessages(org, professionalId, 5, { period: '2026-10', state: 'released' });

    // 199 counted (the released ones are not): one place of the quota is left.
    await org.refresh();
    const usage = await org.api.get('/subscription/usage', org.owner);
    expect(usage.statusCode, usage.body).toBe(200);
    const body = SubscriptionUsageResponse.parse(usage.json());
    expect(body.professionals[0]).toMatchObject({ count: 199, remaining: 1, state: 'warning' });
  });

  it('lets exactly one of two messages prepared at the same moment take the last overage place', async () => {
    const { org, professionalId } = await active({ cap: 5, messages: 204 });
    const [first, second] = await seedBareMessages(org, professionalId, 2);
    const tenant = { tenantId: org.tenant.id, userId: org.owner.user.id };
    const policy = quota();

    const outcomes = await Promise.all(
      [first, second].map((messageId) =>
        world.deps.withTenant(tenant, (tx) =>
          reserveWhatsappUsage(policy, tx, {
            messageId: messageId ?? '',
            professionalId,
            now: clock.now,
          }),
        ),
      ),
    );

    expect([...outcomes].sort()).toEqual(['exhausted', 'reserved']);
  });
});

describe('the usage the owner sees (task 6.25)', () => {
  it('shows each professional and the total: usage, quota, remaining and what the overage would cost', async () => {
    const { org, professionalId } = await active({ cap: 100, messages: 230 });
    const other = await org.professional();
    const otherId = await professionalIdOf(org, other);
    await seedActiveDays(org, otherId, days('2026-10', 1, 19));
    await seedMessages(org, otherId, 50, { period: '2026-10' });
    await org.refresh();

    const response = await org.api.get('/subscription/usage', org.owner);

    expect(response.statusCode, response.body).toBe(200);
    const body: Usage = SubscriptionUsageResponse.parse(response.json());
    expect(body.period).toBe('2026-10');
    expect(body.professionals.find((p) => p.professionalId === professionalId)).toMatchObject({
      count: 230,
      quota: 200,
      remaining: 0,
      overageUnits: 30,
      state: 'exhausted',
    });
    expect(body.professionals.find((p) => p.professionalId === otherId)).toMatchObject({
      count: 50,
      quota: 200,
      remaining: 150,
      overageUnits: 0,
      state: 'ok',
    });
    expect(body.totals).toEqual({ count: 280, quota: 400, remaining: 150, overageUnits: 30 });
    expect(body.overage).toEqual({
      capMessages: 100,
      capMax: 3000,
      unitPriceCents: 6_000,
      billableUnits: 30,
      projectedCents: 180_000,
      capReached: false,
    });
  });

  it('carries counts only: no message text, no patient, no address', async () => {
    const { org } = await active({ messages: 10 });
    await org.refresh();

    const response = await org.api.get('/subscription/usage', org.owner);

    expect(response.body).not.toMatch(/Apellido|Nombre|@|texto|body|phone|tel[eé]fono/i);
    expect(Object.keys(response.json<Record<string, unknown>>()).sort()).toEqual([
      'overage',
      'period',
      'professionals',
      'totals',
    ]);
  });

  it('is for the owner only, and says "no billing" where there is none', async () => {
    const { org } = await active();
    const exempt = await world.organization({ billingExempt: true });

    for (const role of ['professional', 'reception', 'admin'] as const) {
      expect((await org.api.get('/subscription/usage', await org.member(role))).statusCode).toBe(
        403,
      );
    }
    const response = await exempt.api.get('/subscription/usage', exempt.owner);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'subscription_exempt' });
  });
});

describe('the overage cap the owner sets (task 6.27)', () => {
  const setCap = (org: SubscriptionOrganization, body: unknown) =>
    org.api.patch('/subscription/overage-cap', org.owner, body);

  it('takes any whole number from zero to the maximum of the plan, and audits the change', async () => {
    const { org } = await active({ cap: 300 });
    await org.refresh();

    for (const value of [0, 1, 500, 3000]) {
      const response = await setCap(org, { overageCapMessages: value });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ overageCapMessages: value });
    }

    expect(await org.subscription()).toMatchObject({ overage_cap_messages: 3000 });
    const audit = await org.run(
      sql`select metadata from audit_event where action = 'subscription.cap_changed'`,
    );
    const changes = audit.map((row) => row['metadata'] as { from: number; to: number });
    expect(changes.sort((a, b) => a.to - b.to)).toEqual([
      { from: 300, to: 0 },
      { from: 0, to: 1 },
      { from: 1, to: 500 },
      { from: 500, to: 3000 },
    ]);
  });

  it('refuses a value above the maximum, and anything that is not a whole number: it is never unlimited', async () => {
    const { org } = await active({ cap: 300 });
    await org.refresh();

    const above = await setCap(org, { overageCapMessages: 3001 });
    expect(above.statusCode).toBe(422);
    expect(above.json()).toMatchObject({ code: 'subscription_overage_cap_too_high' });
    for (const value of [
      -1,
      1.5,
      null,
      'ilimitado',
      'unlimited',
      Number.MAX_SAFE_INTEGER * 2,
      {},
    ]) {
      const response = await setCap(org, { overageCapMessages: value });
      expect(response.statusCode, JSON.stringify(value)).toBe(400);
    }
    expect((await setCap(org, {})).statusCode).toBe(400);
    expect((await setCap(org, { overageCapMessages: 10, unlimited: true })).statusCode).toBe(400);
    expect(await org.subscription()).toMatchObject({ overage_cap_messages: 300 });
  });

  it('is for the owner only', async () => {
    const { org } = await active({ cap: 300 });

    for (const role of ['professional', 'reception', 'admin'] as const) {
      const member = await org.member(role);
      expect(
        (await org.api.patch('/subscription/overage-cap', member, { overageCapMessages: 1 }))
          .statusCode,
      ).toBe(403);
    }
    expect(await org.subscription()).toMatchObject({ overage_cap_messages: 300 });
  });
});

describe('the counts the operator reads (task 6.28)', () => {
  it('shows days of activity and messages per professional and period, for a deployment that bills nothing', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization({ billingExempt: true });
    const professionalId = await professionalIdOf(org, await org.professional());
    await seedMessages(org, professionalId, 12, { period: '2026-10' });
    await seedMessages(org, professionalId, 3, { period: '2026-09' });
    await runUsageSnapshot(world.deps, org.tenant.id);
    setNow('2026-10-21T15:00:00.000Z');
    await runUsageSnapshot(world.deps, org.tenant.id);
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    subscriptionOperatorRoutes({
      run: createOperatorRun(operatorSide.db.db),
      clock: () => clock.now,
    })(app);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/operator/usage?tenantId=${org.tenant.id}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(OperatorUsageResponse.parse(response.json())).toEqual({
      id: org.tenant.id,
      periods: [
        { period: '2026-09', professionals: [{ professionalId, activeDays: 0, messages: 3 }] },
        { period: '2026-10', professionals: [{ professionalId, activeDays: 2, messages: 12 }] },
      ],
    });
    // Counts only: nothing that names a person or a message.
    expect(response.body).not.toMatch(/Apellido|Nombre|@/);
    await app.close();
  });

  it('shows nothing of another organization', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const mine = await world.organization({ billingExempt: true });
    const other = await world.organization({ billingExempt: true });
    await professionalIdOf(other, await other.professional());
    await runUsageSnapshot(world.deps, other.tenant.id);
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    subscriptionOperatorRoutes({
      run: createOperatorRun(operatorSide.db.db),
      clock: () => clock.now,
    })(app);
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: `/operator/usage?tenantId=${mine.tenant.id}`,
    });

    expect(response.json()).toEqual({ id: mine.tenant.id, periods: [] });
    await app.close();
  });
});

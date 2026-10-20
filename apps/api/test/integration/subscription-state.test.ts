import {
  OperatorSubscriptionDto,
  PlanImpactResponse,
  SUBSCRIPTION_STATUSES,
  SubscriptionResponse,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { plan as planTable } from '../../src/db/schema/subscriptions.js';
import { ALLOWED_TRANSITIONS } from '../../src/modules/subscriptions/domain/subscription-state.js';
import {
  createSubscriptionPlanImpact,
  createTrialStarter,
} from '../../src/modules/subscriptions/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { createClinicalWorld, type ClinicalWorld } from '../support/clinical-world.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from '../support/operator.js';
import { asTenant, createTestTenant } from '../support/tenants.js';

/**
 * The plans and the subscription model (S6.01, tasks 6.5 to 6.8): the tables and their guards, the
 * trial, the plan limit that the staff module asks for, the owner's view and the support view of the
 * operator. The state machine itself is proven without a database in `subscription-state.test.ts`
 * of the domain; here the database repeats its table as a backstop.
 */

let runtime: DbHandle;
let owner: pg.Client;
let harness: OperatorHarness;
let clock: TestClock;
let world: ClinicalWorld;
let operatorCookie: string;

const NOW = new Date('2026-10-20T15:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  harness = createOperatorHarness();
  clock = createTestClock(NOW);
  world = await createClinicalWorld(runtime, 'sub-state', {
    clock: () => NOW,
    operator: { database: harness.db, secrets: harness.secrets },
  });
  operatorCookie = await operatorSession(world.app, await harness.addOperator(), clock);
});

afterAll(async () => {
  await world.close();
  await harness.close();
  await owner.end();
  await runtime.close();
});

let tenants = 0;
async function freshTenant(overrides: { billingExempt?: boolean; isDemo?: boolean } = {}) {
  tenants += 1;
  return createTestTenant(runtime, { slug: `sub-state-${String(tenants)}`, ...overrides });
}

const starter = createTrialStarter({ clock: () => NOW });

async function trialFor(tenantId: string) {
  return asTenant(runtime, tenantId, (tx) => starter.startTrial(tx, { tenantId }));
}

async function rowOf(tenantId: string) {
  const result = await asTenant(runtime, tenantId, (tx) =>
    tx.execute(sql`SELECT * FROM subscription`),
  );
  return result.rows;
}

/** A plan of its own with room for `max` professionals, written as the owner of the schema. */
async function planWithRoom(max: number): Promise<string> {
  const key = `room-${String(max)}-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`;
  const result = await owner.query<{ id: string }>(
    `INSERT INTO plan (key, name, price_per_professional_cents, max_active_professionals,
                       overage_unit_price_cents, overage_cap_default, overage_cap_max)
     VALUES ($1, 'Plan de prueba', 1000000, $2, 5000, 100, 1000) RETURNING id`,
    [key, max],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('the plan was not created');
  return id;
}

describe('the plans of the platform (task 6.5)', () => {
  it('start with the standard plan: ARS, 14 days of trial, 7 of grace, 200 messages for each professional', async () => {
    const plans = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .select()
        .from(planTable)
        .where(sql`${planTable.key} = 'standard'`),
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      currency: 'ARS',
      trialDays: 14,
      graceDays: 7,
      whatsappQuotaPerProfessional: 200,
      active: true,
    });
    expect(plans[0]?.overageCapDefault).toBeLessThanOrEqual(plans[0]?.overageCapMax ?? 0);
  });

  it('are read by every organization and written by none: not even a price can be edited by a tenant', async () => {
    await expect(
      asTenant(runtime, world.tenant.id, (tx) =>
        tx.execute(sql`UPDATE plan SET price_per_professional_cents = 1 WHERE key = 'standard'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, world.tenant.id, (tx) =>
        tx.execute(
          sql`INSERT INTO plan (key, name, price_per_professional_cents, max_active_professionals,
                                overage_unit_price_cents, overage_cap_default, overage_cap_max)
              VALUES ('mine', 'Mine', 1, 1, 1, 0, 0)`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, world.tenant.id, (tx) => tx.execute(sql`DELETE FROM plan`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('are written by the platform operator as data, with no release', async () => {
    const key = `operator-${String(Date.now())}`;

    await harness.db.db.execute(
      sql`INSERT INTO plan (key, name, price_per_professional_cents, max_active_professionals,
                            overage_unit_price_cents, overage_cap_default, overage_cap_max)
          VALUES (${key}, 'Plan del operador', 1500000, 5, 5000, 10, 100)`,
    );
    await harness.db.db.execute(
      sql`UPDATE plan SET price_per_professional_cents = 1600000 WHERE key = ${key}`,
    );

    const read = await owner.query<{ price: string }>(
      `SELECT price_per_professional_cents::text AS price FROM plan WHERE key = $1`,
      [key],
    );
    expect(read.rows[0]?.price).toBe('1600000');
  });

  it('refuse a cap above the maximum, a quota below zero, another currency and a grace of no days', async () => {
    for (const bad of [
      `overage_cap_default = 2000, overage_cap_max = 100`,
      `whatsapp_quota_per_professional = -1`,
      `currency = 'USD'`,
      `grace_days = 0`,
    ]) {
      await expect(
        owner.query(`UPDATE plan SET ${bad} WHERE key = 'standard'`),
        bad,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });
});

describe('the subscription of an organization (task 6.5)', () => {
  it('is created by starting the trial: 14 days, the default cap of the plan, one audit entry', async () => {
    const tenant = await freshTenant();

    const result = await trialFor(tenant.id);

    expect(result).toEqual({
      status: 'started',
      trialEndsAt: new Date(NOW.getTime() + 14 * 86_400_000),
    });
    const [row] = await rowOf(tenant.id);
    expect(row).toMatchObject({ status: 'trial', dunning_step: 0, authorization_state: 'none' });
    const audit = await asTenant(runtime, tenant.id, (tx) =>
      tx.execute<{ action: string; metadata: Record<string, unknown> }>(
        sql`SELECT action, metadata FROM audit_event WHERE action = 'subscription.created'`,
      ),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.metadata).toMatchObject({ plan: 'standard', status: 'trial' });
  });

  it('is started once: asking again, or twice at the same time, finds the same trial', async () => {
    const tenant = await freshTenant();

    const results = await Promise.all([trialFor(tenant.id), trialFor(tenant.id)]);
    const again = await trialFor(tenant.id);

    expect(results.map((result) => result.status).sort()).toEqual(['already_started', 'started']);
    expect(again.status).toBe('already_started');
    expect(await rowOf(tenant.id)).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'started') as { trialEndsAt: Date }).trialEndsAt,
    ).toEqual((again as { trialEndsAt: Date }).trialEndsAt);
  });

  it('is never created for an exempt organization: a demo or one billed outside the platform', async () => {
    const demo = await freshTenant({ isDemo: true, billingExempt: true });
    const exempt = await freshTenant({ billingExempt: true });

    expect(await trialFor(demo.id)).toEqual({ status: 'exempt' });
    expect(await trialFor(exempt.id)).toEqual({ status: 'exempt' });
    expect(await rowOf(demo.id)).toEqual([]);
    expect(await rowOf(exempt.id)).toEqual([]);
  });

  it('is refused by the database for an exempt organization even when the application is bypassed', async () => {
    const exempt = await freshTenant({ billingExempt: true });
    const demo = await freshTenant({ isDemo: true });

    for (const tenant of [exempt, demo]) {
      await expect(
        asTenant(runtime, tenant.id, (tx) =>
          tx.execute(
            sql`INSERT INTO subscription (tenant_id, plan_id, trial_ends_at, overage_cap_messages)
                VALUES (${tenant.id}, (SELECT id FROM plan WHERE key = 'standard'), now(), 10)`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: '23000' } });
    }
  });

  it('allows the changes of state that the transition table allows, and no other', async () => {
    const results: string[] = [];
    for (const from of SUBSCRIPTION_STATUSES) {
      for (const to of SUBSCRIPTION_STATUSES) {
        if (from === to) continue;
        const tenant = await freshTenant();
        await asTenant(runtime, tenant.id, (tx) =>
          tx.execute(
            sql`INSERT INTO subscription (tenant_id, plan_id, status, trial_ends_at, grace_ends_at, overage_cap_messages)
                VALUES (${tenant.id}, (SELECT id FROM plan WHERE key = 'standard'), ${from},
                        now() - interval '30 days', now() + interval '1 day', 10)`,
          ),
        );
        const outcome = await asTenant(runtime, tenant.id, (tx) =>
          tx
            .execute(
              sql`UPDATE subscription SET status = ${to}, grace_ends_at = now() + interval '1 day'`,
            )
            .then(
              () => 'allowed',
              (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? 'error',
            ),
        );
        const expected = (ALLOWED_TRANSITIONS[from] as readonly string[]).includes(to)
          ? 'allowed'
          : '23514';
        if (outcome !== expected)
          results.push(`${from} -> ${to}: ${outcome}, expected ${expected}`);
      }
    }

    expect(results).toEqual([]);
  }, 120_000);

  it('keeps the organization and the end of the trial as they were', async () => {
    const tenant = await freshTenant();
    await trialFor(tenant.id);

    await expect(
      asTenant(runtime, tenant.id, (tx) =>
        tx.execute(sql`UPDATE subscription SET trial_ends_at = trial_ends_at + interval '1 day'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });

  it('is not deleted by the application', async () => {
    const tenant = await freshTenant();
    await trialFor(tenant.id);

    await expect(
      asTenant(runtime, tenant.id, (tx) => tx.execute(sql`DELETE FROM subscription`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('is isolated: another organization reads none of it', async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    await trialFor(a.id);

    expect(await rowOf(a.id)).toHaveLength(1);
    expect(await rowOf(b.id)).toHaveLength(0);
  });
});

describe('the notices of the payments provider (task 6.5)', () => {
  it('are recorded once by the id the provider gave them, and never changed', async () => {
    const tenant = await freshTenant();
    const insert = (eventId: string) =>
      asTenant(runtime, tenant.id, (tx) =>
        tx.execute(
          sql`INSERT INTO subscription_event (tenant_id, event_id, topic, resource_id, signed_at)
              VALUES (${tenant.id}, ${eventId}, 'payment', 'PAY-1', now())`,
        ),
      );
    const id = `evt-${String(Date.now())}`;

    await insert(id);

    await expect(insert(id)).rejects.toMatchObject({ cause: { code: '23505' } });
    await expect(
      asTenant(runtime, tenant.id, (tx) =>
        tx.execute(sql`UPDATE subscription_event SET resource_id = 'PAY-2'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '23000' } });
  });
});

describe('the limit of professionals of the plan (task 6.8)', () => {
  let limited: ClinicalWorld;

  beforeAll(async () => {
    limited = await createClinicalWorld(runtime, 'sub-limit', { clock: () => NOW });
    // Two professionals now; the plan allows three.
    await limited.professional();
    await limited.professional();
    await asTenant(runtime, limited.tenant.id, (tx) =>
      starter.startTrial(tx, { tenantId: limited.tenant.id }),
    );
    const roomForThree = await planWithRoom(3);
    await asTenant(runtime, limited.tenant.id, (tx) =>
      tx.execute(sql`UPDATE subscription SET plan_id = ${roomForThree}`),
    );
  }, 180_000);

  afterAll(async () => {
    await limited.close();
  });

  const invite = (email: string, roles: string[]) =>
    limited.api.post('/staff/invitations', limited.owner, { email, roles });

  it('lets the third professional in and refuses the fourth, with the reason', async () => {
    const third = await invite('tercero@example.test', ['professional']);
    const fourth = await invite('cuarto@example.test', ['professional']);

    expect(third.statusCode, third.body).toBe(201);
    expect(fourth.statusCode).toBe(409);
    expect(fourth.json()).toMatchObject({ code: 'subscription_professional_limit' });
  });

  it('counts the invitations that are still open as seats that will be taken', async () => {
    const fifth = await invite('quinto@example.test', ['professional', 'admin']);

    expect(fifth.statusCode).toBe(409);
  });

  it('never limits reception or administration: those seats are free and unlimited', async () => {
    for (const [index, roles] of [['reception'], ['admin'], ['reception']].entries()) {
      const response = await invite(`libre-${String(index)}@example.test`, roles);
      expect(response.statusCode, response.body).toBe(201);
    }
  });

  it('refuses to bring a deactivated professional back while the plan has no room', async () => {
    const extra = await asTenant(runtime, limited.tenant.id, async (tx) => {
      const result = await tx.execute<{ id: string; membership_id: string }>(
        sql`SELECT p.id, p.membership_id FROM professional p ORDER BY p.created_at LIMIT 1`,
      );
      return result.rows[0];
    });
    if (!extra) throw new Error('no professional to deactivate');
    const off = await limited.api.post(`/staff/${extra.membership_id}/deactivate`, limited.owner);
    expect(off.statusCode, off.body).toBe(200);
    // The open invitation takes the seat that was just freed.
    const again = await invite('sexto@example.test', ['professional']);
    expect(again.statusCode).toBe(201);

    const back = await limited.api.post(`/staff/${extra.membership_id}/reactivate`, limited.owner);

    expect(back.statusCode).toBe(409);
    expect(back.json()).toMatchObject({ code: 'subscription_professional_limit' });
  });

  it('does not hold an organization with no plan to hold it to: an exempt one invites freely', async () => {
    const exempt = await createClinicalWorld(runtime, 'sub-exempt', { clock: () => NOW });
    await asTenant(runtime, exempt.tenant.id, (tx) =>
      tx.execute(sql`UPDATE tenant SET billing_exempt = true`),
    );
    try {
      for (let index = 0; index < 4; index += 1) {
        const response = await exempt.api.post('/staff/invitations', exempt.owner, {
          email: `libre-${String(index)}@example.test`,
          roles: ['professional'],
        });
        expect(response.statusCode, response.body).toBe(201);
      }
    } finally {
      await exempt.close();
    }
  }, 120_000);
});

describe('what inviting does to the plan (task 6.8)', () => {
  it('says a professional affects the plan and reception does not', async () => {
    const tenant = await freshTenant();
    await trialFor(tenant.id);
    const impact = createSubscriptionPlanImpact();

    const professional = await asTenant(runtime, tenant.id, (tx) =>
      impact.preview(tx, { roles: ['professional'] }),
    );
    const reception = await asTenant(runtime, tenant.id, (tx) =>
      impact.preview(tx, { roles: ['reception', 'admin'] }),
    );

    expect(professional).toEqual({ affectsPlan: true });
    expect(reception).toEqual({ affectsPlan: false });
  });

  it('says nothing changes for an organization with no plan to affect', async () => {
    const exempt = await freshTenant({ billingExempt: true });
    const without = await freshTenant();
    const impact = createSubscriptionPlanImpact();

    for (const tenant of [exempt, without]) {
      expect(
        await asTenant(runtime, tenant.id, (tx) => impact.preview(tx, { roles: ['professional'] })),
      ).toEqual({ affectsPlan: false });
    }
  });

  it('shows the owner the price change and the proration before they confirm', async () => {
    const shown = await createClinicalWorld(runtime, 'sub-impact', { clock: () => NOW });
    try {
      await shown.professional();
      await shown.professional();
      await asTenant(runtime, shown.tenant.id, (tx) =>
        starter.startTrial(tx, { tenantId: shown.tenant.id }),
      );

      const response = await shown.api.get(
        '/subscription/plan-impact?professionals=1',
        shown.owner,
      );

      expect(response.statusCode, response.body).toBe(200);
      const impact = PlanImpactResponse.parse(response.json());
      expect(impact).toMatchObject({
        affectsPlan: true,
        activeProfessionals: { now: 2, after: 3 },
        monthlyCents: { now: 3_600_000, after: 5_400_000 },
        monthlyDifferenceCents: 1_800_000,
        // 12 of the 31 days of October remain on the 20th (the day counts).
        daysLeft: 12,
        daysInPeriod: 31,
        periodEndsOn: '2026-10-31',
        proratedThisPeriodCents: 696_774,
        limit: { max: 20, reached: false },
      });
    } finally {
      await shown.close();
    }
  }, 120_000);

  it('is read by the owner alone: a professional, reception and an admin are denied', async () => {
    const professional = await world.professional();

    for (const session of [professional.session, world.reception, world.admin]) {
      const view = await world.api.get('/subscription', session);
      const impact = await world.api.get('/subscription/plan-impact', session);
      expect(view.statusCode).toBe(403);
      expect(impact.statusCode).toBe(403);
    }
  });
});

describe('the subscription as its owner sees it (task 6.8)', () => {
  it('shows an organization with no subscription yet the plan it would start on', async () => {
    const view = await world.api.get('/subscription', world.owner);

    expect(view.statusCode, view.body).toBe(200);
    const body = SubscriptionResponse.parse(view.json());
    expect(body).toMatchObject({ exempt: false, subscription: null, simulated: false });
    expect(body.plan?.key).toBe('standard');
  });

  it('shows the state, its dates and the next transition', async () => {
    const shown = await createClinicalWorld(runtime, 'sub-view', { clock: () => NOW });
    try {
      await shown.professional();
      await asTenant(runtime, shown.tenant.id, (tx) =>
        starter.startTrial(tx, { tenantId: shown.tenant.id }),
      );

      const view = await shown.api.get('/subscription', shown.owner);

      const body = SubscriptionResponse.parse(view.json());
      expect(body.subscription).toMatchObject({
        status: 'trial',
        trialEndsAt: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
        graceEndsAt: null,
        paidThrough: null,
        nextTransition: {
          kind: 'trial_ends',
          at: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
        },
        authorization: 'none',
        activeProfessionals: 1,
        monthlyPriceCents: 1_800_000,
        needsAttention: false,
      });
      expect(JSON.stringify(body)).not.toMatch(/card|token|secret/i);
    } finally {
      await shown.close();
    }
  }, 120_000);

  it('says "account without billing" for a demo: no plan, no trial, no limit', async () => {
    const demo = await createClinicalWorld(runtime, 'sub-demo-view', { clock: () => NOW });
    try {
      await asTenant(runtime, demo.tenant.id, (tx) =>
        tx.execute(sql`UPDATE tenant SET billing_exempt = true`),
      );

      const view = await demo.api.get('/subscription', demo.owner);

      expect(SubscriptionResponse.parse(view.json())).toMatchObject({
        exempt: true,
        subscription: null,
        plan: null,
      });
    } finally {
      await demo.close();
    }
  }, 120_000);
});

describe('the support view of the platform operator (task 6.8)', () => {
  const send = (url: string, cookie?: string) =>
    world.app.inject({
      method: 'GET',
      url,
      headers: platformHeaders(cookie),
      remoteAddress: '10.96.8.1',
    });

  it('shows the state, the dates and the counters of an organization, and nothing about a person', async () => {
    const tenant = await freshTenant();
    await trialFor(tenant.id);

    const response = await send(`/operator/tenants/${tenant.id}/subscription`, operatorCookie);

    expect(response.statusCode, response.body).toBe(200);
    const view = OperatorSubscriptionDto.parse(response.json());
    expect(view).toMatchObject({
      id: tenant.id,
      status: 'trial',
      planKey: 'standard',
      dunningStep: 0,
      authorization: 'none',
    });
    expect(response.body).not.toMatch(/email|patient|paciente|card|tarjeta/i);
  });

  it('lists the subscriptions of every organization', async () => {
    const tenant = await freshTenant();
    await trialFor(tenant.id);

    const response = await send('/operator/subscriptions', operatorCookie);

    expect(response.statusCode, response.body).toBe(200);
    const listed = response.json<{ subscriptions: { id: string }[] }>().subscriptions;
    expect(listed.map((entry) => entry.id)).toContain(tenant.id);
  });

  it('answers not found for an organization with no subscription, and needs the operator session', async () => {
    const exempt = await freshTenant({ billingExempt: true });

    expect(
      (await send(`/operator/tenants/${exempt.id}/subscription`, operatorCookie)).statusCode,
    ).toBe(404);
    expect((await send(`/operator/tenants/${exempt.id}/subscription`)).statusCode).toBe(401);
  });

  it('reaches no patient or clinical table: the operator role has no privilege on one', async () => {
    const tenant = await freshTenant();
    await trialFor(tenant.id);

    for (const table of ['patient', 'encounter', 'clinical_note', 'prescription', 'membership']) {
      await expect(
        harness.db.db.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.tenant_id', ${tenant.id}, true)`);
          return tx.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`);
        }),
        table,
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

  it('is not served without the console: the application built without an operator has no such route', async () => {
    const bare = buildTestApplication(runtime, { clock: clock.read });
    try {
      await bare.ready();
      const response = await bare.inject({
        method: 'GET',
        url: '/operator/subscriptions',
        headers: platformHeaders(),
        remoteAddress: '10.96.8.2',
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

import { StatementsResponse, type StatementDto } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { exportSubscriptions } from '../../src/modules/subscriptions/application/export-contributor.js';
import { reconcileSubscription } from '../../src/modules/subscriptions/application/reconcile.js';
import { generateStatements } from '../../src/modules/subscriptions/application/statements.js';
import { runUsageSnapshot } from '../../src/modules/subscriptions/application/usage.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { localHarness, type LocalHarness } from '../support/payments-harness.js';
import {
  createSubscriptionWorld,
  type SubscriptionOrganization,
  type SubscriptionWorld,
} from '../support/subscription-world.js';
import { professionalIdOf, seedActiveDays, seedMessages } from '../support/usage-seed.js';

/**
 * The statements of the subscription (tasks 6.22 to 6.25, 6.27): the metering of the professionals and
 * of the messages, the statement written at the close of a period and published to the owner, and its
 * collection against the local Mercado Pago. Nothing is collected without a published statement the
 * owner could see for the length of the window, and never above its total, whatever the provider does.
 */

let runtime: DbHandle;
let owner: pg.Client;
let world: SubscriptionWorld;
let provider: LocalHarness;
const clock = { now: new Date('2026-10-20T15:00:00.000Z') };
const DAY = 86_400_000;
const setNow = (iso: string) => {
  clock.now = new Date(iso);
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  provider = localHarness(runtime, {
    clock,
    secret: 'statement-test-secret',
    hostedCheckout: true,
  });
  world = await createSubscriptionWorld(runtime, {
    harness: provider,
    clock,
    providerTimeoutMs: 2_000,
  });
});

afterEach(async () => {
  await provider.setMode('ok');
});

afterAll(async () => {
  await world.stop();
  await owner.end();
  await runtime.close();
});

const emailsTo = (org: SubscriptionOrganization) =>
  world.email.sent.filter((message) => message.tenant?.id === org.tenant.id);

const days = (period: string, from: number, to: number) =>
  Array.from(
    { length: to - from + 1 },
    (_, index) => `${period}-${String(from + index).padStart(2, '0')}`,
  );

describe('the metering of the professionals (task 6.22)', () => {
  it('records one day per active professional, once, however many times the snapshot runs', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    const doctor = await org.professional();
    const professionalId = await professionalIdOf(org, doctor);

    const first = await runUsageSnapshot(world.deps, org.tenant.id);
    const again = await runUsageSnapshot(world.deps, org.tenant.id);
    setNow('2026-10-21T15:00:00.000Z');
    const next = await runUsageSnapshot(world.deps, org.tenant.id);

    expect(first.days).toBe(1);
    expect(again.days).toBe(0);
    expect(next.days).toBe(1);
    const rows = await org.run(
      sql`select day, quantity from usage_record where kind = 'active_professional_day' and professional_id = ${professionalId} order by day`,
    );
    expect(rows.map((row) => row['day'])).toEqual(['2026-10-20', '2026-10-21']);
  });

  it('stops recording a professional who is deactivated: the quota and the price follow the days', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    const doctor = await org.professional();
    const professionalId = await professionalIdOf(org, doctor);
    await runUsageSnapshot(world.deps, org.tenant.id);

    await org.run(sql`update professional set status = 'inactive' where id = ${professionalId}`);
    setNow('2026-10-21T15:00:00.000Z');
    await runUsageSnapshot(world.deps, org.tenant.id);

    const rows = await org.run(
      sql`select day from usage_record where kind = 'active_professional_day' order by day`,
    );
    expect(rows.map((row) => row['day'])).toEqual(['2026-10-20']);
  });

  it('rolls up the messages the provider accepted, per professional and period, and nothing else', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    const professionalId = await professionalIdOf(org, await org.professional());
    await seedMessages(org, professionalId, 5, { period: '2026-10' });
    await seedMessages(org, professionalId, 2, { period: '2026-10', state: 'released' });
    await seedMessages(org, professionalId, 3, { period: '2026-10', state: 'reserved' });
    await seedMessages(org, professionalId, 4, { period: '2026-09' });

    const written = await runUsageSnapshot(world.deps, org.tenant.id);
    const again = await runUsageSnapshot(world.deps, org.tenant.id);

    expect(written.months).toBe(2);
    expect(again.months).toBe(0);
    const rows = await org.run(
      sql`select period, quantity from usage_record where kind = 'whatsapp_messages' order by period`,
    );
    expect(rows.map((row) => [row['period'], row['quantity']])).toEqual([
      ['2026-09', 4],
      ['2026-10', 5],
    ]);
  });

  it('meters nothing for a demo, and keeps metering a deployment that bills outside the platform', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const demo = await world.organization({ isDemo: true, billingExempt: true });
    const unbilled = await world.organization({ billingExempt: true });
    await demo.professional();
    await unbilled.professional();

    await runUsageSnapshot(world.deps, demo.tenant.id);
    await runUsageSnapshot(world.deps, unbilled.tenant.id);

    expect(await demo.rows('usage_record')).toHaveLength(0);
    expect(await unbilled.rows('usage_record')).toHaveLength(1);
  });
});

describe('the statement of a closed period (tasks 6.23 and 6.27)', () => {
  /** An organization whose trial ended in August, with two professionals, September metered. */
  async function meteredOrganization(
    options: { cap?: number } = {},
  ): Promise<{ org: SubscriptionOrganization; first: string; second: string; events: string[] }> {
    setNow('2026-08-01T15:00:00.000Z');
    const org = await world.organization();
    const first = await professionalIdOf(org, await org.professional());
    const second = await professionalIdOf(org, await org.professional());
    if (options.cap !== undefined) {
      await org.run(sql`update subscription set overage_cap_messages = ${options.cap}`);
    }
    await seedActiveDays(org, first, days('2026-09', 1, 30));
    await seedActiveDays(org, second, days('2026-09', 1, 10));
    const events = await seedMessages(org, first, 230, { period: '2026-09' });
    await seedMessages(org, second, 20, { period: '2026-09' });
    setNow('2026-10-02T12:00:00.000Z');
    return { org, first, second, events };
  }

  it('lists the professionals counted, the unit price, the prorations, the overage and the total', async () => {
    const { org, first, second, events } = await meteredOrganization();

    const result = await generateStatements(world.deps, org.tenant.id);

    expect(result.generated).toBe(1);
    const [row] = await org.rows('statement');
    expect(row).toMatchObject({
      period: '2026-09',
      professionals_counted: 2,
      // 18.000 + 10/30 of 18.000, in cents.
      base_cents: '2400000',
      overage_units: 30,
      // 30 messages beyond the 200 of the first, at 60 pesos.
      overage_cents: '180000',
      total_cents: '2580000',
      collected_cents: '0',
    });
    const lines = row?.['lines'] as {
      kind: string;
      professionalId: string;
      [key: string]: unknown;
    }[];
    expect(lines).toHaveLength(3);
    expect(
      lines.find((line) => line.kind === 'professional' && line.professionalId === second),
    ).toMatchObject({
      days: 10,
      daysInPeriod: 30,
      amountCents: 600_000,
    });
    // The overage line traces back to the counted events: the 30 after the quota, in order.
    const overage = lines.find((line) => line.kind === 'overage');
    expect(overage).toMatchObject({
      professionalId: first,
      quota: 200,
      used: 230,
      units: 30,
      unitPriceCents: 6_000,
      eventIds: events.slice(200),
    });
  });

  it('is published and emailed to the owner once, with no patient data, and collected no earlier than three days after', async () => {
    const { org } = await meteredOrganization();

    await generateStatements(world.deps, org.tenant.id);
    await generateStatements(world.deps, org.tenant.id);

    const rows = await org.rows('statement');
    expect(rows).toHaveLength(1);
    const publishedAt = new Date(String(rows[0]?.['published_at']));
    const collectAfter = new Date(String(rows[0]?.['collect_after']));
    expect(publishedAt.toISOString()).toBe('2026-10-02T12:00:00.000Z');
    expect(collectAfter.getTime() - publishedAt.getTime()).toBe(3 * DAY);
    const mails = emailsTo(org);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ subject: 'Resumen de septiembre de 2026' });
    expect(mails[0]?.text).toContain('$ 25.800,00');
    expect(mails[0]?.text).toContain('5 de octubre de 2026');
    expect(mails[0]?.text).toContain('30 mensajes excedentes');
    expect(mails[0]?.text).not.toMatch(/Apellido|Nombre|historia cl[ií]nica/i);
  });

  it('bills no more overage than the cap of the organization, and none at all when it is zero', async () => {
    const capped = await meteredOrganization({ cap: 10 });
    await generateStatements(world.deps, capped.org.tenant.id);
    const off = await meteredOrganization({ cap: 0 });
    await generateStatements(world.deps, off.org.tenant.id);

    expect((await capped.org.rows('statement'))[0]).toMatchObject({
      overage_units: 10,
      overage_cents: '60000',
      total_cents: '2460000',
      overage_cap_messages: 10,
    });
    expect((await off.org.rows('statement'))[0]).toMatchObject({
      overage_units: 0,
      overage_cents: '0',
      total_cents: '2400000',
    });
  });

  it('does not bill the days of the trial, and writes nothing for a period nobody was billed in', async () => {
    setNow('2026-10-20T15:00:00.000Z');
    const org = await world.organization();
    const professionalId = await professionalIdOf(org, await org.professional());
    // The trial runs to 3 November: October is free, so the statement of October is empty.
    await seedActiveDays(org, professionalId, days('2026-10', 20, 31));
    setNow('2026-11-02T12:00:00.000Z');

    expect((await generateStatements(world.deps, org.tenant.id)).generated).toBe(0);
    expect(await org.rows('statement')).toHaveLength(0);

    // From 3 November the days are billed: the statement of November has them.
    await seedActiveDays(org, professionalId, days('2026-11', 3, 30));
    setNow('2026-12-02T12:00:00.000Z');
    expect((await generateStatements(world.deps, org.tenant.id)).generated).toBe(1);
    expect((await org.rows('statement'))[0]).toMatchObject({
      period: '2026-11',
      // 28 of 30 days of 18.000 pesos.
      base_cents: '1680000',
    });
  });

  it('writes no statement for an organization without billing', async () => {
    setNow('2026-10-02T12:00:00.000Z');
    const org = await world.organization({ billingExempt: true });
    const professionalId = await professionalIdOf(org, await org.professional());
    await seedActiveDays(org, professionalId, days('2026-09', 1, 30));

    expect((await generateStatements(world.deps, org.tenant.id)).generated).toBe(0);
  });

  it('shows the owner the statements, with the lines and without the events; the detail and the document', async () => {
    const { org, events } = await meteredOrganization();
    await generateStatements(world.deps, org.tenant.id);
    await org.refresh();

    const listed = await org.api.get('/subscription/statements', org.owner);
    expect(listed.statusCode, listed.body).toBe(200);
    const body = StatementsResponse.parse(listed.json());
    expect(body.statements).toHaveLength(1);
    const [statement] = body.statements as [StatementDto];
    expect(statement).toMatchObject({
      period: '2026-09',
      totalCents: 2_580_000,
      collectedCents: 0,
      paymentUrl: null,
      reauthorizationUrl: null,
    });
    for (const line of statement.lines) expect(line).not.toHaveProperty('eventIds');

    const detail = await org.api.get(`/subscription/statements/${statement.id}`, org.owner);
    expect(detail.statusCode, detail.body).toBe(200);
    const shown: StatementDto = detail.json();
    const overage = shown.lines.find((line) => line.kind === 'overage');
    expect(overage?.kind === 'overage' ? overage.eventIds : []).toEqual(events.slice(200));
    expect(detail.body).not.toMatch(/Apellido|Nombre/);

    const document = await org.api.get(
      `/subscription/statements/${statement.id}/document`,
      org.owner,
    );
    expect(document.statusCode).toBe(200);
    expect(document.headers['content-type']).toBe('application/pdf');
    expect(document.headers['cache-control']).toBe('no-store');
    expect(document.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('goes with the export of an organization that leaves, without the identifiers of the provider', async () => {
    const { org } = await meteredOrganization();
    await generateStatements(world.deps, org.tenant.id);

    const exported = (await world.deps.withTenant(
      { tenantId: org.tenant.id, userId: org.owner.user.id },
      (tx) => exportSubscriptions({ tx } as never),
    )) as {
      subscription: Record<string, unknown> | null;
      statements: Record<string, unknown>[];
      payments: unknown[];
    };

    expect(exported.subscription).toMatchObject({ plan: 'standard', status: 'trial' });
    expect(exported.statements).toHaveLength(1);
    expect(exported.statements[0]).toMatchObject({ period: '2026-09', totalCents: 2_580_000 });
    expect(JSON.stringify(exported)).not.toMatch(/preapproval|payer|idempotency|@/i);
  });

  it('is for the owner only: a professional, a receptionist and an administrator are refused', async () => {
    const { org } = await meteredOrganization();
    await generateStatements(world.deps, org.tenant.id);
    const [row] = await org.rows('statement');
    const url = `/subscription/statements/${String(row?.['id'])}`;

    for (const role of ['professional', 'reception', 'admin'] as const) {
      const member = await org.member(role);
      expect((await org.api.get('/subscription/statements', member)).statusCode).toBe(403);
      expect((await org.api.get(url, member)).statusCode).toBe(403);
      expect((await org.api.get(`${url}/document`, member)).statusCode).toBe(403);
    }
  });

  it("never shows another organization's statement", async () => {
    const mine = await meteredOrganization();
    const other = await meteredOrganization();
    await generateStatements(world.deps, mine.org.tenant.id);
    await generateStatements(world.deps, other.org.tenant.id);
    const [theirs] = await other.org.rows('statement');
    await mine.org.refresh();

    const response = await mine.org.api.get(
      `/subscription/statements/${String(theirs?.['id'])}`,
      mine.org.owner,
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('what a published statement is in the database', () => {
  async function published(): Promise<{ org: SubscriptionOrganization; id: string }> {
    setNow('2026-08-01T12:00:00.000Z');
    const org = await world.organization();
    setNow('2026-10-02T12:00:00.000Z');
    const [row] = await org.run(
      sql`insert into statement (tenant_id, subscription_id, period, plan_id, professionals_counted,
                                  base_cents, total_cents, overage_cap_messages, lines, published_at, collect_after)
            select current_setting('app.tenant_id')::uuid, s.id, '2026-09', s.plan_id, 1, 1800000, 1800000, 300,
                   '[]'::jsonb, '2026-10-02T12:00:00Z', '2026-10-05T12:00:00Z' from subscription s
            returning id`,
    );
    return { org, id: String(row?.['id']) };
  }

  it('cannot be changed once it is published: the figures, the window, the lines', async () => {
    const { org, id } = await published();

    for (const change of [
      sql`total_cents = 1, base_cents = 1`,
      sql`base_cents = 1700000`,
      sql`collect_after = '2026-10-03T12:00:00Z'`,
      sql`published_at = '2026-09-01T12:00:00Z'`,
      sql`lines = '[{"kind":"x"}]'::jsonb`,
      sql`overage_cap_messages = 5000`,
    ]) {
      await expect(org.run(sql`update statement set ${change} where id = ${id}`)).rejects.toThrow();
    }
  });

  it('cannot be collected below zero or above its total, and what was collected never goes down', async () => {
    const { org, id } = await published();

    await expect(
      org.run(sql`update statement set collected_cents = 1800001 where id = ${id}`),
    ).rejects.toThrow();
    await org.run(sql`update statement set collected_cents = 900000 where id = ${id}`);
    await expect(
      org.run(sql`update statement set collected_cents = 800000 where id = ${id}`),
    ).rejects.toThrow();
  });

  it('is never published with less than three days before it is collected', async () => {
    const { org } = await published();

    await expect(
      org.run(
        sql`insert into statement (tenant_id, subscription_id, period, plan_id, professionals_counted,
                                    base_cents, total_cents, overage_cap_messages, lines, published_at, collect_after)
              select current_setting('app.tenant_id')::uuid, s.id, '2026-08', s.plan_id, 1, 1, 1, 300,
                     '[]'::jsonb, '2026-10-02T12:00:00Z', '2026-10-04T11:59:59Z' from subscription s`,
      ),
    ).rejects.toThrow();
  });

  it('is never deleted by the application', async () => {
    const { org, id } = await published();

    await expect(org.run(sql`delete from statement where id = ${id}`)).rejects.toThrow();
  });

  it('refuses a write to the provider for it before its window, or for more than is left to collect', async () => {
    const { org, id } = await published();
    const attempt = (marked: string, amount: number) =>
      org.run(
        sql`insert into subscription_attempt (tenant_id, subscription_id, kind, external_reference,
                                               idempotency_key, amount_cents, statement_id, state, marked_at, settle_until)
              select current_setting('app.tenant_id')::uuid, s.id, 'amount_change', 'sub:guard',
                     ${`key-${marked}-${String(amount)}`}, ${amount}, ${id}, 'marked',
                     ${marked}::timestamptz, ${marked}::timestamptz + interval '1 minute'
                from subscription s`,
      );

    // The window ends on 5 October at noon.
    await expect(attempt('2026-10-05T11:59:59Z', 1_800_000)).rejects.toThrow();
    await expect(attempt('2026-10-05T12:00:00Z', 1_800_001)).rejects.toThrow();
    await expect(attempt('2026-10-05T12:00:00Z', 1_800_000)).resolves.toBeDefined();
  });
});

describe('collecting a published statement (task 6.24)', () => {
  /**
   * An organization that subscribed in October (authorized, the first charge paid), with the statement
   * of October published on 1 November. The recurring amount is the 18.000 pesos shown at checkout.
   */
  async function subscribed(
    total: number,
  ): Promise<{ org: SubscriptionOrganization; preapprovalId: string; statementId: string }> {
    setNow('2026-09-01T15:00:00.000Z');
    const org = await world.organization();
    setNow('2026-10-20T15:00:00.000Z');
    await org.refresh();
    const started = await org.checkout();
    expect(started.statusCode, started.body).toBe(200);
    const preapprovalId = String((await org.subscription())['provider_preapproval_id']);
    await provider.authorize(preapprovalId);
    await reconcileSubscription(world.deps, org.tenant.id);
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcileSubscription(world.deps, org.tenant.id);
    expect(await org.subscription()).toMatchObject({
      status: 'active',
      authorized_amount_cents: '1800000',
    });

    setNow('2026-11-01T15:00:00.000Z');
    const [row] = await org.run(
      sql`insert into statement (tenant_id, subscription_id, period, plan_id, professionals_counted,
                                  base_cents, total_cents, overage_cap_messages, lines, published_at, collect_after)
            select current_setting('app.tenant_id')::uuid, s.id, '2026-10', s.plan_id, 1, ${total}, ${total}, 300,
                   '[]'::jsonb, ${clock.now.toISOString()}::timestamptz,
                   ${new Date(clock.now.getTime() + 3 * DAY).toISOString()}::timestamptz from subscription s
            returning id`,
    );
    return { org, preapprovalId, statementId: String(row?.['id']) };
  }

  const reconcile = (org: SubscriptionOrganization) =>
    reconcileSubscription(world.deps, org.tenant.id);
  const attemptsOf = (org: SubscriptionOrganization) =>
    org.run(
      sql`select kind, state, message, amount_cents, previous_amount_cents, external_reference, resource_id, resource_url, statement_id
            from subscription_attempt where statement_id is not null order by marked_at, created_at`,
    );
  const statementOf = async (org: SubscriptionOrganization) => (await org.rows('statement'))[0];
  const amountAtProvider = async (preapprovalId: string) => {
    const lookup = await provider.local.getPreapproval(preapprovalId);
    if (lookup.status !== 'found') throw new Error('the provider does not hold the preapproval');
    return lookup.preapproval.amountCents;
  };

  it('does not touch the amount before the owner had three days to see the statement', async () => {
    const { org, preapprovalId } = await subscribed(2_580_000);
    setNow('2026-11-04T14:59:59.000Z');

    await reconcile(org);

    expect(await attemptsOf(org)).toEqual([]);
    expect(await amountAtProvider(preapprovalId)).toBe(1_800_000);
  });

  it('moves the recurring amount to the statement total once the window passed, and books the charge against it', async () => {
    const { org, preapprovalId } = await subscribed(2_580_000);
    setNow('2026-11-04T15:00:00.000Z');

    await reconcile(org);
    await reconcile(org);

    expect(await attemptsOf(org)).toMatchObject([
      {
        kind: 'amount_change',
        state: 'confirmed',
        amount_cents: '2580000',
        previous_amount_cents: '1800000',
      },
    ]);
    expect(await amountAtProvider(preapprovalId)).toBe(2_580_000);
    expect(await org.subscription()).toMatchObject({ authorized_amount_cents: '2580000' });
    expect(await statementOf(org)).toMatchObject({ collected_cents: '0', collected_at: null });

    // The charge of November takes exactly the statement total.
    setNow('2026-11-06T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);

    expect(await statementOf(org)).toMatchObject({ collected_cents: '2580000' });
    expect((await statementOf(org))?.['collected_at']).not.toBeNull();
    // Nothing else is asked of the provider for it.
    await reconcile(org);
    expect(await attemptsOf(org)).toHaveLength(1);
  });

  it('lowers the amount too when the statement is below what was authorized', async () => {
    const { org, preapprovalId } = await subscribed(1_200_000);
    setNow('2026-11-04T15:00:00.000Z');

    await reconcile(org);

    expect(await amountAtProvider(preapprovalId)).toBe(1_200_000);
  });

  it('collects the difference by a payment link when the provider will not change the amount, and tells the owner', async () => {
    const { org, preapprovalId, statementId } = await subscribed(2_580_000);
    await provider.setMode('refuse_amount_change');
    setNow('2026-11-04T15:00:00.000Z');

    await reconcile(org);
    await reconcile(org);

    const attempts = await attemptsOf(org);
    expect(attempts).toMatchObject([
      { kind: 'amount_change', state: 'rejected', message: 'amount_change_refused' },
      {
        kind: 'payment_link',
        state: 'confirmed',
        amount_cents: '780000',
        statement_id: statementId,
      },
    ]);
    expect(attempts[1]?.['external_reference']).toMatch(new RegExp(`^stmt:${statementId}:1$`));
    // The recurring charge was left as it was; one link only, however often it is looked at.
    expect(await amountAtProvider(preapprovalId)).toBe(1_800_000);
    const mails = emailsTo(org).filter(
      (m) => m.subject === 'Hay una diferencia para pagar de su resumen',
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]?.text).toContain('$ 25.800,00');

    // The owner finds the link next to the statement.
    await org.refresh();
    const listed = StatementsResponse.parse(
      (await org.api.get('/subscription/statements', org.owner)).json(),
    );
    expect(listed.statements[0]?.paymentUrl).toBe(attempts[1]?.['resource_url']);

    // The link is paid, then the recurring charge takes the rest: the total is collected, no more.
    await provider.payLink(String(attempts[1]?.['resource_id']));
    await reconcile(org);
    expect(await statementOf(org)).toMatchObject({ collected_cents: '780000' });
    setNow('2026-11-06T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);

    expect(await statementOf(org)).toMatchObject({ collected_cents: '2580000' });
    const payments = await org.run(
      sql`select purpose, amount_cents, statement_id from subscription_payment where statement_id is not null order by provider_created_at`,
    );
    expect(payments).toMatchObject([
      { purpose: 'statement', amount_cents: '780000' },
      { purpose: 'charge', amount_cents: '1800000' },
    ]);
    // The link is gone from the statement once paid.
    await org.refresh();
    const after = StatementsResponse.parse(
      (await org.api.get('/subscription/statements', org.owner)).json(),
    );
    expect(after.statements[0]?.paymentUrl).toBeNull();
  });

  it('asks the owner to authorize the new amount when the provider needs it, and charges nothing for the difference', async () => {
    const { org, preapprovalId } = await subscribed(2_580_000);
    await provider.setMode('reauthorize');
    setNow('2026-11-04T15:00:00.000Z');

    await reconcile(org);
    await reconcile(org);

    const attempts = await attemptsOf(org);
    expect(attempts).toMatchObject([
      { kind: 'amount_change', state: 'rejected', message: 'reauthorization_required' },
    ]);
    expect(String(attempts[0]?.['resource_url'])).toContain(
      '/local-providers/mercadopago/checkout/',
    );
    expect(await amountAtProvider(preapprovalId)).toBe(1_800_000);
    const mails = emailsTo(org).filter(
      (m) => m.subject === 'Necesitamos que autorice nuevamente el monto',
    );
    expect(mails).toHaveLength(1);

    await org.refresh();
    const listed = StatementsResponse.parse(
      (await org.api.get('/subscription/statements', org.owner)).json(),
    );
    expect(listed.statements[0]).toMatchObject({
      paymentUrl: null,
      reauthorizationUrl: attempts[0]?.['resource_url'],
    });
    // What the recurring charge collects is at most what the owner saw, and nothing is asked again.
    expect(await attemptsOf(org)).toHaveLength(1);
  });

  it('parks the subscription instead of charging more than is owed when it cannot lower the amount', async () => {
    const { org, preapprovalId } = await subscribed(1_200_000);
    await provider.setMode('refuse_amount_change');
    setNow('2026-11-04T15:00:00.000Z');

    await reconcile(org);
    await reconcile(org);

    expect(await org.subscription()).toMatchObject({ attention_reason: 'reauthorization_needed' });
    const attempts = await attemptsOf(org);
    expect(attempts).toMatchObject([{ kind: 'amount_change', state: 'rejected' }]);
    expect(attempts.some((a) => a['kind'] === 'payment_link')).toBe(false);
    expect(await amountAtProvider(preapprovalId)).toBe(1_800_000);
    expect(
      emailsTo(org).filter((m) => m.subject === 'Necesitamos que autorice nuevamente el monto'),
    ).toHaveLength(1);
  });

  it('does not park the subscription when the recurring charge lands while the difference link is payable (JD-S6 R1, C1)', async () => {
    const { org, preapprovalId } = await subscribed(2_580_000);
    await provider.setMode('refuse_amount_change');
    setNow('2026-11-04T15:00:00.000Z');
    await reconcile(org);
    await reconcile(org);
    const link = (await attemptsOf(org)).find((a) => a['kind'] === 'payment_link');
    expect(link).toMatchObject({ state: 'confirmed', amount_cents: '780000' });

    // The recurring charge takes its 18.000 before the owner pays the link: what is left of the
    // statement is now less than the authorization, and the link is still payable.
    setNow('2026-11-06T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);
    await reconcile(org);

    expect(await org.subscription()).toMatchObject({ attention_reason: null });
    expect((await attemptsOf(org)).filter((a) => a['kind'] === 'payment_link')).toHaveLength(1);
    await provider.payLink(String(link?.['resource_id']));
    await reconcile(org);
    expect(await statementOf(org)).toMatchObject({ collected_cents: '2580000' });
  });

  it('lets a subscription parked for an amount go by itself once the charge has landed and the statement is collected (JD-S6 R1, C1)', async () => {
    const { org, preapprovalId } = await subscribed(1_200_000);
    await provider.setMode('refuse_amount_change');
    setNow('2026-11-04T15:00:00.000Z');
    await reconcile(org);
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ attention_reason: 'reauthorization_needed' });
    // It does not freeze the dates while it waits.
    await reconcile(org);
    expect(await org.subscription()).toMatchObject({ attention_reason: 'reauthorization_needed' });

    setNow('2026-11-06T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);

    expect(await statementOf(org)).toMatchObject({ collected_cents: '1200000' });
    expect(await org.subscription()).toMatchObject({ attention_reason: null, attention_at: null });
    const cleared = await org.run(
      sql`select 1 from audit_event where action = 'subscription.state_changed' and reason = 'attention_cleared'`,
    );
    expect(cleared).toHaveLength(1);
  });

  it('collects the oldest statement first and the next one only when it is paid', async () => {
    const { org, preapprovalId } = await subscribed(2_580_000);
    await org.run(
      sql`insert into statement (tenant_id, subscription_id, period, plan_id, professionals_counted,
                                  base_cents, total_cents, overage_cap_messages, lines, published_at, collect_after)
            select current_setting('app.tenant_id')::uuid, s.id, '2026-11', s.plan_id, 1, 1900000, 1900000, 300,
                   '[]'::jsonb, '2026-12-01T15:00:00Z', '2026-12-04T15:00:00Z' from subscription s`,
    );
    setNow('2026-11-04T15:00:00.000Z');
    await reconcile(org);
    setNow('2026-11-06T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);
    const byPeriod = (await org.rows('statement')).sort((a, b) =>
      String(a['period']).localeCompare(String(b['period'])),
    );
    expect(byPeriod.map((s) => [s['period'], s['collected_cents']])).toEqual([
      ['2026-10', '2580000'],
      ['2026-11', '0'],
    ]);

    // Before the second statement's window, the amount stays as the first one left it.
    setNow('2026-12-03T15:00:00.000Z');
    await reconcile(org);
    expect(await amountAtProvider(preapprovalId)).toBe(2_580_000);
    setNow('2026-12-04T15:00:00.000Z');
    await reconcile(org);
    expect(await amountAtProvider(preapprovalId)).toBe(1_900_000);
  });

  it('never books a charge that came before the window against the statement', async () => {
    const { org, preapprovalId } = await subscribed(2_580_000);
    // The provider charges on its own schedule on 2 November: the owner is still reading the statement.
    setNow('2026-11-02T15:00:00.000Z');
    await provider.chargeCycle(preapprovalId, 'approved');
    await reconcile(org);

    expect(await statementOf(org)).toMatchObject({ collected_cents: '0' });
  });
});

import { randomBytes } from 'node:crypto';

import { SubscriptionResponse } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { DEMO_PASSWORD } from '../../src/db/seed/demo/credentials.js';
import {
  PLATFORM_DEMO_TENANTS,
  seedPlatformDemo,
  type PlatformDemoDeps,
} from '../../src/db/seed/demo/stage6/platform-tenants.js';
import { seedPlatformCatalogs } from '../../src/db/seed/platform.js';
import { createPasswordHasher } from '../../src/modules/identity/infrastructure/argon2.js';
import { periodOf, previousPeriod } from '../../src/modules/subscriptions/index.js';
import { createTenantLookup } from '../../src/modules/tenancy/index.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createPublicOrigins } from '../../src/platform/http/public-origin.js';
import { BASE_DOMAIN, buildTestApplication } from '../support/app.js';
import { clientFor, signInAs } from '../support/session.js';
import { asTenant } from '../support/tenants.js';

/**
 * The platform demo (task 6.47, `pnpm demo:platform`): four fictional organizations that are not
 * demonstration ones, one in each state of the subscription, built by the real services of the
 * subscription module against the local Mercado Pago. They exist for the operator's views; the demo
 * organization itself shows the exempt state and has no subscription at all.
 */

const DAY = 86_400_000;
let runtime: DbHandle;
let deps: PlatformDemoDeps;
let now: Date;

const subscriptionOf = (slug: string) =>
  rowsOf(
    slug,
    sql`select s.status, s.trial_ends_at, s.paid_through, s.grace_ends_at, s.dunning_step,
               s.authorization_state, t.status as tenant_status, t.read_only_since,
               t.is_demo, t.billing_exempt
          from subscription s join tenant t on t.id = s.tenant_id`,
  ).then((rows) => rows[0]);

async function rowsOf(slug: string, statement: ReturnType<typeof sql>) {
  const found = await createTenantLookup(runtime.db)(slug);
  if (!found) throw new Error(`no organization ${slug}`);
  const id = found.id;
  return (await asTenant(runtime, id, (tx) => tx.execute(statement))).rows;
}

beforeAll(async () => {
  const ownerDb = createOwnerDb(inject('ownerUrl'));
  await seedPlatformCatalogs(ownerDb.db);
  await ownerDb.close();
  runtime = createRuntimeDb(inject('runtimeUrl'));
  now = new Date();
  deps = {
    db: runtime.db,
    withTenant: createWithTenant(runtime.db),
    hasher: createPasswordHasher(),
    origins: createPublicOrigins({ mode: 'multi', baseDomain: BASE_DOMAIN }, { secure: true }),
    webhookSecret: randomBytes(24).toString('hex'),
    publicBaseUrl: `https://platform.${BASE_DOMAIN}`,
    environment: 'test',
    now: () => now,
  };
});

afterAll(async () => {
  await runtime.close();
});

describe('the four organizations of the platform demo', () => {
  it('names one organization for each state, none of them a demonstration one', () => {
    expect(PLATFORM_DEMO_TENANTS.map((entry) => entry.state)).toEqual([
      'trial',
      'active',
      'past_due',
      'read_only',
    ]);
    expect(new Set(PLATFORM_DEMO_TENANTS.map((entry) => entry.slug)).size).toBe(4);
    expect(new Set(PLATFORM_DEMO_TENANTS.map((entry) => entry.ownerEmail)).size).toBe(4);
  });

  it('builds each one in its state through the services of the subscription', async () => {
    const result = await seedPlatformDemo(deps);

    expect(result.map((entry) => [entry.state, entry.created])).toEqual([
      ['trial', true],
      ['active', true],
      ['past_due', true],
      ['read_only', true],
    ]);
    const bySlug = Object.fromEntries(
      await Promise.all(
        PLATFORM_DEMO_TENANTS.map(async (entry) => [entry.state, await subscriptionOf(entry.slug)]),
      ),
    ) as Record<string, Record<string, unknown>>;

    for (const row of Object.values(bySlug)) {
      expect(row).toMatchObject({ is_demo: false, billing_exempt: false });
    }
    // Trial: day 5 of 14.
    expect(bySlug['trial']).toMatchObject({ status: 'trial', tenant_status: 'active' });
    const trialEnds = new Date(String(bySlug['trial']?.['trial_ends_at'])).getTime();
    expect(trialEnds - now.getTime()).toBeGreaterThan(8 * DAY);
    expect(trialEnds - now.getTime()).toBeLessThan(10 * DAY);
    // Active: authorized and paid beyond today.
    expect(bySlug['active']).toMatchObject({
      status: 'active',
      authorization_state: 'authorized',
      tenant_status: 'active',
    });
    expect(new Date(String(bySlug['active']?.['paid_through'])).getTime()).toBeGreaterThan(
      now.getTime(),
    );
    // Past due: the charge failed three days ago, the first two reminders went, the grace is open.
    expect(bySlug['past_due']).toMatchObject({
      status: 'past_due',
      dunning_step: 2,
      tenant_status: 'active',
    });
    expect(new Date(String(bySlug['past_due']?.['grace_ends_at'])).getTime()).toBeGreaterThan(
      now.getTime(),
    );
    // Read-only: the grace ended and the organization is read-only.
    expect(bySlug['read_only']).toMatchObject({
      status: 'read_only',
      dunning_step: 3,
      tenant_status: 'read_only',
    });
    expect(bySlug['read_only']?.['read_only_since']).not.toBeNull();
    expect(new Date(String(bySlug['read_only']?.['grace_ends_at'])).getTime()).toBeLessThan(
      now.getTime(),
    );
  });

  it('leaves the owners able to sign in with the documented password and see their state', async () => {
    const app = buildTestApplication(runtime, { clock: () => now });
    await app.ready();
    try {
      for (const entry of PLATFORM_DEMO_TENANTS) {
        const session = await signInAs(
          app,
          entry.slug,
          { id: 'unused', email: entry.ownerEmail, membershipId: 'unused' },
          DEMO_PASSWORD,
        );
        const view = await clientFor(app, entry.slug).get('/subscription', session);

        expect(view.statusCode, view.body).toBe(200);
        const body = SubscriptionResponse.parse(view.json());
        expect(body.exempt).toBe(false);
        expect(body.subscription?.status).toBe(entry.state);
      }
    } finally {
      await app.close();
    }
  });

  it('gives the active organization a professional, the days they were active and the statement of the month that closed', async () => {
    const entry = PLATFORM_DEMO_TENANTS.find((candidate) => candidate.state === 'active');
    const slug = entry?.slug ?? '';
    const professionals = await rowsOf(
      slug,
      sql`select count(*)::int as n from professional p join membership m on m.id = p.membership_id
           where p.status = 'active' and m.status = 'active' and 'professional' = any(m.roles)`,
    );
    const days = await rowsOf(
      slug,
      sql`select count(*)::int as n, min(day) as first, max(day) as last from usage_record where kind = 'active_professional_day'`,
    );
    const statements = await rowsOf(
      slug,
      sql`select period, professionals_counted, base_cents, total_cents from statement order by period`,
    );

    expect(professionals[0]?.['n']).toBe(1);
    // From the day the trial ended to yesterday, one record a day.
    expect(days[0]?.['n']).toBeGreaterThanOrEqual(6);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      period: previousPeriod(periodOf(now)),
      professionals_counted: 1,
    });
    expect(Number(statements[0]?.['total_cents'])).toBeGreaterThan(0);
  });

  it('shows the owner the statement through the product, with counts and no patient', async () => {
    const app = buildTestApplication(runtime, { clock: () => now });
    await app.ready();
    try {
      const entry = PLATFORM_DEMO_TENANTS.find((candidate) => candidate.state === 'active');
      const slug = entry?.slug ?? '';
      const session = await signInAs(
        app,
        slug,
        { id: 'unused', email: entry?.ownerEmail ?? '', membershipId: 'unused' },
        DEMO_PASSWORD,
      );
      const api = clientFor(app, slug);

      const statements = await api.get('/subscription/statements', session);
      const usage = await api.get('/subscription/usage', session);

      expect(statements.statusCode, statements.body).toBe(200);
      expect(statements.json<{ statements: { period: string }[] }>().statements).toHaveLength(1);
      expect(usage.statusCode, usage.body).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('gives every organization a reception, who cannot see the billing, and who is refused a write in the read-only one', async () => {
    const app = buildTestApplication(runtime, { clock: () => now });
    await app.ready();
    try {
      for (const entry of PLATFORM_DEMO_TENANTS) {
        const session = await signInAs(
          app,
          entry.slug,
          { id: 'unused', email: entry.receptionEmail, membershipId: 'unused' },
          DEMO_PASSWORD,
        );
        const api = clientFor(app, entry.slug);

        const billing = await api.get('/subscription', session);
        const write = await api.post('/patients', session, {
          familyName: 'Prueba',
          givenNames: 'Paciente',
          birthDate: '1990-01-01',
          dataProcessingConsent: true,
        });

        expect(billing.statusCode, entry.slug).toBe(403);
        if (entry.state === 'read_only') {
          expect(write.statusCode, write.body).toBe(402);
          expect(write.json<{ code: string }>().code).toBe('tenant_read_only');
          // The reason, with no word about the billing.
          expect(write.body).not.toMatch(/suscripci|pago|Mercado|\$/i);
        } else {
          expect(write.statusCode, `${entry.slug}: ${write.body}`).toBe(201);
        }
      }
    } finally {
      await app.close();
    }
  });

  it('is safe to run again: what exists is left as it is', async () => {
    const before = await subscriptionOf('prueba-vencida');

    const again = await seedPlatformDemo(deps);

    expect(again.map((entry) => entry.created)).toEqual([false, false, false, false]);
    expect(await subscriptionOf('prueba-vencida')).toEqual(before);
    const count = await rowsOf('prueba-vencida', sql`select count(*)::int as n from subscription`);
    expect(count[0]?.['n']).toBe(1);
  });

  it('refuses to run in production, and creates nothing', async () => {
    await expect(seedPlatformDemo({ ...deps, environment: 'production' })).rejects.toThrow(
      /never runs in production/,
    );
  });
});

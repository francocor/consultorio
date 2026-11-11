import type { CreateTenantResponse, MeResponse } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { actionToken } from '../../src/db/schema/action-token.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { platformAuditEvent } from '../../src/db/schema/operator.js';
import { tenantKey } from '../../src/db/schema/tenant-key.js';
import { tenant, tenantFeature } from '../../src/db/schema/tenant.js';
import type { DemoResetPort } from '../../src/modules/operator/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { browserHeaders, buildTestApplication } from '../support/app.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
  type TestOperator,
} from '../support/operator.js';
import { signInAs } from '../support/session.js';
import { asTenant } from '../support/tenants.js';
import type { TestUser } from '../support/users.js';

const OWNER_PASSWORD = 'una frase larga para entrar como dueño';

let runtime: DbHandle;
let harness: OperatorHarness;
let app: FastifyInstance;
let clock: TestClock;
let email: FakeEmailSender;
let operator: TestOperator;
let cookie: string;
const resets: { tenantId: string; operatorId: string }[] = [];

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  email = createFakeEmailSender();
  const demoReset: DemoResetPort = {
    reset: (input) => {
      resets.push(input);
      return Promise.resolve();
    },
  };
  app = buildTestApplication(runtime, {
    operator: { database: harness.db, secrets: harness.secrets, demoReset },
    clock: clock.read,
    email,
  });
  operator = await harness.addOperator();
  await app.ready();
  cookie = await operatorSession(app, operator, clock);
});

afterAll(async () => {
  await app.close();
  await harness.close();
  await runtime.close();
});

const operatorPost = (url: string, payload: unknown, session: string | undefined = cookie) =>
  app.inject({
    method: 'POST',
    url,
    headers: platformHeaders(session),
    remoteAddress: '10.96.0.1',
    payload: payload as object,
  });
const operatorGet = (url: string) =>
  app.inject({ method: 'GET', url, headers: platformHeaders(cookie), remoteAddress: '10.96.0.1' });

const createTenant = (name: string, ownerEmail: string, isDemo?: boolean) =>
  operatorPost('/operator/tenants', {
    name,
    ownerEmail,
    ...(isDemo === undefined ? {} : { isDemo }),
  });

const tokenFromEmail = (to: string): string => {
  const link = email.linkIn(email.lastTo(to));
  const token = link ? new URL(link).searchParams.get('token') : null;
  if (!token) throw new Error('no invitation link was sent');
  return token;
};

async function platformEvents(tenantId: string) {
  return harness.db.db
    .select()
    .from(platformAuditEvent)
    .where(eq(platformAuditEvent.targetTenantId, tenantId));
}

describe('POST /operator/tenants', () => {
  it('creates the organization, its data key, defaults and the owner invitation', async () => {
    const response = await createTenant('Centro Médico Norte', 'duena@norte.test');

    expect(response.statusCode).toBe(201);
    const body = response.json<CreateTenantResponse>();
    expect(body.tenant).toMatchObject({
      slug: 'centro-medico-norte',
      name: 'Centro Médico Norte',
      status: 'active',
      isDemo: false,
      country: 'AR',
    });
    expect(body.invitationSent).toBe(true);
    // The invitation travels by email only: nothing in the response can open the organization.
    expect(JSON.stringify(body)).not.toMatch(/token/i);

    const id = body.tenant.id;
    const keys = await asTenant(runtime, id, (tx) =>
      tx.select({ version: tenantKey.version, status: tenantKey.status }).from(tenantKey),
    );
    expect(keys).toEqual([{ version: 1, status: 'active' }]);
    const [row] = await asTenant(runtime, id, (tx) =>
      tx.select({ theme: tenant.theme, settings: tenant.settings }).from(tenant),
    );
    expect(row).toEqual({ theme: { displayName: 'Centro Médico Norte' }, settings: {} });
  });

  it('emails the owner a single-use link on the new organization host, with no password', async () => {
    const response = await createTenant('Clínica del Sur', 'dueno@sur.test');
    const body = response.json<CreateTenantResponse>();

    const message = email.lastTo('dueno@sur.test');
    const link = email.linkIn(message) ?? '';

    expect(new URL(link).host).toBe(`${body.tenant.slug}.consultorio.test`);
    expect(new URL(link).pathname).toBe('/accept-invitation');
    expect(message?.text).toContain('Clínica del Sur');
    expect(message?.text).not.toMatch(/contraseña:\s*\S+/i);
  });

  it('lets the owner choose a password, sign in, and see only their own organization', async () => {
    const a = (
      await createTenant('Consultorio Alfa', 'owner@alfa.test')
    ).json<CreateTenantResponse>();
    const b = (
      await createTenant('Consultorio Beta', 'owner@beta.test')
    ).json<CreateTenantResponse>();

    for (const [created, address] of [
      [a, 'owner@alfa.test'],
      [b, 'owner@beta.test'],
    ] as const) {
      const accepted = await app.inject({
        method: 'POST',
        url: '/auth/invitations/accept',
        headers: browserHeaders(created.tenant.slug),
        remoteAddress: '10.96.0.2',
        payload: { token: tokenFromEmail(address), password: OWNER_PASSWORD },
      });
      expect(accepted.statusCode).toBe(204);
    }

    const session = await signInAs(
      app,
      a.tenant.slug,
      { id: '', email: 'owner@alfa.test', membershipId: '' } satisfies TestUser,
      OWNER_PASSWORD,
    );
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: browserHeaders(a.tenant.slug, session.cookie),
      remoteAddress: '10.96.0.2',
    });
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().roles).toEqual(['owner']);

    // The same person's session is worthless on the other organization.
    const onOther = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: browserHeaders(b.tenant.slug, session.cookie),
      remoteAddress: '10.96.0.2',
    });
    expect(onOther.statusCode).toBe(401);
  });

  it('hides a slug collision: the second organization quietly gets another address', async () => {
    const first = (
      await createTenant('Salud Integral', 'a@integral.test')
    ).json<CreateTenantResponse>();
    const second = await createTenant('Salud Integral', 'b@integral.test');

    expect(second.statusCode).toBe(201);
    const slug = second.json<CreateTenantResponse>().tenant.slug;
    expect(first.tenant.slug).toBe('salud-integral');
    expect(slug).toMatch(/^salud-integral-[0-9a-f]{4}$/);
    // Nothing in the response says the plain name was taken.
    expect(JSON.stringify(second.json())).not.toMatch(/collision|taken|exists/i);
  });

  it('fixes the demo flag at creation and nothing can change it afterwards', async () => {
    const demo = (
      await createTenant('Demo Uno', 'demo@uno.test', true)
    ).json<CreateTenantResponse>();
    const real = (await createTenant('Real Uno', 'real@uno.test')).json<CreateTenantResponse>();

    expect(demo.tenant.isDemo).toBe(true);
    expect(real.tenant.isDemo).toBe(false);
    for (const [id, flag] of [
      [demo.tenant.id, false],
      [real.tenant.id, true],
    ] as const) {
      await expect(
        asTenant(runtime, id, (tx) =>
          tx.execute(sql`UPDATE tenant SET is_demo = ${flag} WHERE id = ${id}`),
        ),
      ).rejects.toThrow();
    }
    // There is no endpoint that edits an organization.
    const edit = await app.inject({
      method: 'PATCH',
      url: `/operator/tenants/${real.tenant.id}`,
      headers: platformHeaders(cookie),
      remoteAddress: '10.96.0.1',
      payload: { isDemo: true },
    });
    expect(edit.statusCode).toBe(404);
  });

  it('records the creation on both trails', async () => {
    const created = (
      await createTenant('Trazada', 'dueno@trazada.test', true)
    ).json<CreateTenantResponse>();
    const id = created.tenant.id;

    const own = await asTenant(runtime, id, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'tenant.created')),
    );
    const platform = (await platformEvents(id)).filter(
      (event) => event.action === 'tenant.created',
    );

    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ outcome: 'allow', actorUserId: operator.id, resourceId: id });
    expect(platform).toHaveLength(1);
    expect(platform[0]).toMatchObject({ operatorId: operator.id, outcome: 'allow' });
    expect(JSON.stringify([own, platform])).not.toContain('dueno@trazada.test');
  });

  it('rejects bad input and unauthenticated callers', async () => {
    const noSession = await operatorPost(
      '/operator/tenants',
      { name: 'Sin sesión', ownerEmail: 'x@y.test' },
      '',
    );
    const badEmail = await createTenant('Mala', 'no-es-un-correo');
    const shortName = await createTenant('x', 'ok@ok.test');
    const extra = await operatorPost('/operator/tenants', {
      name: 'Extra',
      ownerEmail: 'ok@ok.test',
      slug: 'elegido-por-el-operador',
    });

    expect(noSession.statusCode).toBe(401);
    expect(badEmail.statusCode).toBe(400);
    expect(shortName.statusCode).toBe(400);
    // Not even the operator chooses the address.
    expect(extra.statusCode).toBe(400);
  });

  it('lists the organizations', async () => {
    await createTenant('Listada', 'dueno@listada.test');

    const response = await operatorGet('/operator/tenants');

    expect(response.statusCode).toBe(200);
    const slugs = response.json<{ tenants: { slug: string }[] }>().tenants.map((row) => row.slug);
    expect(slugs).toContain('listada');
  });
});

describe('the owner invitation of an unclaimed organization', () => {
  it('can be sent again until someone joins, and the old link stops working', async () => {
    const created = (
      await createTenant('Reenvío', 'typo@reenvio.test')
    ).json<CreateTenantResponse>();
    const oldToken = tokenFromEmail('typo@reenvio.test');

    const resent = await operatorPost(`/operator/tenants/${created.tenant.id}/owner-invitation`, {
      ownerEmail: 'real@reenvio.test',
    });
    expect(resent.statusCode).toBe(200);

    const attempt = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/auth/invitations/accept',
        headers: browserHeaders(created.tenant.slug),
        remoteAddress: '10.96.0.3',
        payload: { token, password: OWNER_PASSWORD },
      });
    expect((await attempt(oldToken)).statusCode).toBe(400);
    expect((await attempt(tokenFromEmail('real@reenvio.test'))).statusCode).toBe(204);
  });

  it('is refused once the organization has a member', async () => {
    const created = (
      await createTenant('Ya Reclamada', 'owner@reclamada.test')
    ).json<CreateTenantResponse>();
    await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      headers: browserHeaders(created.tenant.slug),
      remoteAddress: '10.96.0.4',
      payload: { token: tokenFromEmail('owner@reclamada.test'), password: OWNER_PASSWORD },
    });

    const again = await operatorPost(`/operator/tenants/${created.tenant.id}/owner-invitation`, {
      ownerEmail: 'intruso@reclamada.test',
    });

    expect(again.statusCode).toBe(409);
    expect(email.lastTo('intruso@reclamada.test')).toBeUndefined();
  });

  it('cannot be forged at the database level for an organization that has members', async () => {
    const claimed = (
      await createTenant('Forja Uno', 'owner@forja.test')
    ).json<CreateTenantResponse>();
    await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      headers: browserHeaders(claimed.tenant.slug),
      remoteAddress: '10.96.0.5',
      payload: { token: tokenFromEmail('owner@forja.test'), password: OWNER_PASSWORD },
    });
    const unclaimed = (
      await createTenant('Forja Dos', 'owner@forja2.test')
    ).json<CreateTenantResponse>();

    const insert = (tenantId: string, kind: string) =>
      harness.db.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        await tx.insert(actionToken).values({
          tenantId,
          kind,
          tokenHash: uuidv7().replaceAll('-', '').padEnd(64, '0'),
          subjectId: uuidv7(),
          payload: {
            email: 'x@y.test',
            roles: ['owner'],
            invitedBy: operator.id,
            origin: 'operator',
          },
          expiresAt: new Date(Date.now() + 3_600_000),
        });
      });

    await expect(insert(claimed.tenant.id, 'staff_invitation')).rejects.toThrow();
    await expect(insert(unclaimed.tenant.id, 'password_reset')).rejects.toThrow();
    await expect(insert(unclaimed.tenant.id, 'staff_invitation')).resolves.toBeUndefined();
  });

  it('is accepted for the owner role only: an operator-origin token with another role is refused', async () => {
    const created = (
      await createTenant('Rol Único', 'owner@rol.test')
    ).json<CreateTenantResponse>();
    const forged = 'F'.repeat(43);
    const { createHash } = await import('node:crypto');
    await harness.db.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${created.tenant.id}, true)`);
      await tx.insert(actionToken).values({
        tenantId: created.tenant.id,
        kind: 'staff_invitation',
        tokenHash: createHash('sha256').update(forged).digest('hex'),
        subjectId: uuidv7(),
        payload: {
          email: 'admin@rol.test',
          roles: ['admin'],
          invitedBy: operator.id,
          origin: 'operator',
        },
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    });

    const response = await app.inject({
      method: 'POST',
      url: '/auth/invitations/accept',
      headers: browserHeaders(created.tenant.slug),
      remoteAddress: '10.96.0.6',
      payload: { token: forged, password: OWNER_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('POST /operator/tenants/:id/demo-reset', () => {
  it('resets a demo organization through the demo port and records it', async () => {
    const demo = (
      await createTenant('Demo Reset', 'demo@reset.test', true)
    ).json<CreateTenantResponse>();

    const response = await operatorPost(`/operator/tenants/${demo.tenant.id}/demo-reset`, {});

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'done' });
    expect(resets).toContainEqual({ tenantId: demo.tenant.id, operatorId: operator.id });
    const events = (await platformEvents(demo.tenant.id)).filter(
      (event) => event.action === 'tenant.demo_reset',
    );
    expect(events.map((event) => event.outcome)).toEqual(['allow']);
  });

  it('refuses a real organization, whatever the operator says, and records the refusal', async () => {
    const real = (await createTenant('Real Reset', 'real@reset.test')).json<CreateTenantResponse>();
    const before = resets.length;

    const response = await operatorPost(`/operator/tenants/${real.tenant.id}/demo-reset`, {});

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('demo_tenant_required');
    expect(resets).toHaveLength(before);
    const events = (await platformEvents(real.tenant.id)).filter(
      (event) => event.action === 'tenant.demo_reset',
    );
    expect(events.map((event) => [event.outcome, event.reason])).toEqual([
      ['deny', 'not_a_demo_tenant'],
    ]);
  });

  it('answers 404 for an organization that does not exist', async () => {
    const response = await operatorPost(`/operator/tenants/${uuidv7()}/demo-reset`, {});

    expect(response.statusCode).toBe(404);
  });

  it('answers 503 while the demo module has not provided the reset', async () => {
    const bare = buildTestApplication(runtime, {
      operator: { database: harness.db, secrets: harness.secrets },
      clock: clock.read,
      email,
    });
    await bare.ready();
    const session = await operatorSession(bare, operator, clock);
    const created = await bare.inject({
      method: 'POST',
      url: '/operator/tenants',
      headers: platformHeaders(session),
      remoteAddress: '10.96.0.7',
      payload: { name: 'Demo Sin Puerto', ownerEmail: 'demo@puerto.test', isDemo: true },
    });
    const id = created.json<CreateTenantResponse>().tenant.id;

    const response = await bare.inject({
      method: 'POST',
      url: `/operator/tenants/${id}/demo-reset`,
      headers: platformHeaders(session),
      remoteAddress: '10.96.0.7',
      payload: {},
    });
    await bare.close();

    expect(response.statusCode).toBe(503);
  });
});

describe('what the operator database role can do to a tenant', () => {
  it('creates tenants but cannot edit their data or read their settings', async () => {
    const created = (
      await createTenant('Sin Settings', 'owner@settings.test')
    ).json<CreateTenantResponse>();
    const id = created.tenant.id;
    const inContext = <T>(
      fn: (tx: Parameters<Parameters<typeof harness.db.db.transaction>[0]>[0]) => Promise<T>,
    ) =>
      harness.db.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${id}, true)`);
        return fn(tx);
      });

    await expect(
      inContext((tx) => tx.select({ s: tenant.settings }).from(tenant)),
    ).rejects.toThrow();
    await expect(
      inContext((tx) => tx.update(tenant).set({ country: 'UY' }).where(eq(tenant.id, id))),
    ).rejects.toThrow();
    await expect(
      inContext((tx) => tx.update(tenantFeature).set({ enabled: true })),
    ).rejects.toThrow();
    await expect(
      inContext((tx) =>
        tx
          .select({ id: auditEvent.id })
          .from(auditEvent)
          .where(and(eq(auditEvent.tenantId, id))),
      ),
    ).rejects.toThrow();
  });
});

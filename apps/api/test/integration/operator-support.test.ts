import type {
  AuditListResponse,
  SupportGrantDto,
  SupportGrantListResponse,
  SupportOverviewResponse,
} from '@consultorio/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { supportGrant, platformAuditEvent } from '../../src/db/schema/operator.js';
import { location, tenantFeature } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { buildTestApplication } from '../support/app.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
  type TestOperator,
} from '../support/operator.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let harness: OperatorHarness;
let app: FastifyInstance;
let clock: TestClock;
let operator: TestOperator;
let cookie: string;
let tenant: TestTenant;
let other: TestTenant;
let api: ReturnType<typeof clientFor>;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  harness = createOperatorHarness();
  clock = createTestClock();
  app = buildTestApplication(runtime, {
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
  });
  tenant = await createTestTenant(runtime, { slug: 'support-a' });
  other = await createTestTenant(runtime, { slug: 'support-b' });
  api = clientFor(app, 'support-a');
  const session = async (roles: ('owner' | 'admin' | 'reception')[]) =>
    signInAs(
      app,
      'support-a',
      await createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD }),
    );
  owner = await session(['owner']);
  admin = await session(['admin']);
  reception = await session(['reception']);
  await asTenant(runtime, tenant.id, async (tx) => {
    await tx.insert(location).values({
      tenantId: tenant.id,
      name: 'Sede Central',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    await tx
      .insert(tenantFeature)
      .values({ tenantId: tenant.id, feature: 'online_booking', enabled: true });
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

const overview = (tenantId: string) =>
  app.inject({
    method: 'GET',
    url: `/operator/tenants/${tenantId}/support/overview`,
    headers: platformHeaders(cookie),
    remoteAddress: '10.95.0.1',
  });

const openGrant = async (tenantApi = api, session = owner) =>
  (
    await tenantApi.post('/support-grants', session, {
      reason: 'Ayuda con la configuración inicial',
      durationHours: 2,
    })
  ).json<SupportGrantDto>();

const closeAllGrants = (tenantId: string) =>
  asTenant(runtime, tenantId, (tx) =>
    tx.execute(sql`UPDATE support_grant SET revoked_at = now() WHERE revoked_at IS NULL`),
  );

const platformRows = (tenantId: string, action: string) =>
  harness.db.db
    .select()
    .from(platformAuditEvent)
    .where(eq(platformAuditEvent.targetTenantId, tenantId))
    .orderBy(asc(platformAuditEvent.occurredAt))
    .then((rows) => rows.filter((row) => row.action === action));

const tenantRows = (tenantId: string, action: string) =>
  asTenant(runtime, tenantId, (tx) =>
    tx.select().from(auditEvent).where(eq(auditEvent.action, action)),
  );

describe('the organization opens and closes the window', () => {
  it('lets the owner grant support access for a stated reason and time', async () => {
    const response = await api.post('/support-grants', owner, {
      reason: 'Ayuda con la configuración inicial',
      durationHours: 4,
    });

    expect(response.statusCode).toBe(201);
    const grant = response.json<SupportGrantDto>();
    expect(grant.status).toBe('active');
    expect(grant.reason).toBe('Ayuda con la configuración inicial');
    const hours =
      (new Date(grant.expiresAt).getTime() - new Date(grant.startsAt).getTime()) / 3_600_000;
    expect(hours).toBeCloseTo(4, 1);

    const list = await api.get('/support-grants', owner);
    expect(list.json<SupportGrantListResponse>().grants.map((row) => row.id)).toContain(grant.id);
    expect((await tenantRows(tenant.id, 'support.grant.created')).length).toBeGreaterThan(0);
    await closeAllGrants(tenant.id);
  });

  it('is for the owner only: neither an admin nor reception can open it', async () => {
    for (const session of [admin, reception]) {
      const response = await api.post('/support-grants', session, {
        reason: 'Intento no autorizado',
        durationHours: 1,
      });
      expect(response.statusCode).toBe(403);
    }
    expect((await api.get('/support-grants', admin)).statusCode).toBe(403);
  });

  it('is time-boxed: no more than a week, and a reason is required', async () => {
    const tooLong = await api.post('/support-grants', owner, {
      reason: 'Demasiado',
      durationHours: 169,
    });
    const none = await api.post('/support-grants', owner, {
      reason: 'Sin tiempo',
      durationHours: 0,
    });
    const noReason = await api.post('/support-grants', owner, { reason: 'x', durationHours: 2 });

    expect(tooLong.statusCode).toBe(400);
    expect(none.statusCode).toBe(400);
    expect(noReason.statusCode).toBe(400);
  });

  it('never covers clinical content: the scope is administrative and nothing else', async () => {
    await expect(
      asTenant(runtime, tenant.id, (tx) =>
        tx.execute(
          sql`INSERT INTO support_grant (tenant_id, scope, reason, expires_at, granted_by)
              VALUES (${tenant.id}, 'clinical', 'x', now() + interval '1 hour', ${uuidv7()})`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('can be revoked at any moment, once', async () => {
    const grant = await openGrant();

    const revoked = await api.delete(`/support-grants/${grant.id}`, owner);
    const again = await api.delete(`/support-grants/${grant.id}`, owner);

    expect(revoked.statusCode).toBe(204);
    expect(again.statusCode).toBe(404);
    const [row] = await api
      .get('/support-grants', owner)
      .then((r) => r.json<SupportGrantListResponse>().grants.filter((g) => g.id === grant.id));
    expect(row?.status).toBe('revoked');
    expect((await tenantRows(tenant.id, 'support.grant.revoked')).length).toBeGreaterThan(0);
  });

  it('is private to each organization', async () => {
    const grant = await openGrant();
    const otherOwner = await signInAs(
      app,
      'support-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const otherApi = clientFor(app, 'support-b');

    const list = await otherApi.get('/support-grants', otherOwner);
    const revoke = await otherApi.delete(`/support-grants/${grant.id}`, otherOwner);

    expect(list.json<SupportGrantListResponse>().grants).toEqual([]);
    expect(revoke.statusCode).toBe(404);
    await closeAllGrants(tenant.id);
  });
});

describe('the operator uses a grant', () => {
  it('is denied without a grant, and the attempt is recorded', async () => {
    await closeAllGrants(tenant.id);

    const response = await overview(tenant.id);

    expect(response.statusCode).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('support_grant_required');
    const denied = await platformRows(tenant.id, 'support.denied');
    expect(denied.at(-1)).toMatchObject({
      operatorId: operator.id,
      outcome: 'deny',
      reason: 'no_active_grant',
    });
    // Nothing was read, so nothing appears on the organization's trail.
    expect(await tenantRows(tenant.id, 'support.access')).toEqual([]);
  });

  it('is allowed with an active grant, and shows configuration only', async () => {
    const grant = await openGrant();

    const response = await overview(tenant.id);

    expect(response.statusCode).toBe(200);
    const body = response.json<SupportOverviewResponse>();
    expect(body.tenant.slug).toBe('support-a');
    expect(body.locations).toEqual([
      { name: 'Sede Central', timeZone: 'America/Argentina/Buenos_Aires', active: true },
    ]);
    expect(body.features).toEqual([{ feature: 'online_booking', enabled: true }]);
    expect(body.grantExpiresAt).toBe(grant.expiresAt);
    // No people and no care: the response has nothing of the sort to show.
    expect(Object.keys(body).sort()).toEqual(['features', 'grantExpiresAt', 'locations', 'tenant']);
    await closeAllGrants(tenant.id);
  });

  it('audits each use on both trails, and the organization can see it', async () => {
    await openGrant();
    const before = (await platformRows(tenant.id, 'support.access')).length;

    expect((await overview(tenant.id)).statusCode).toBe(200);
    expect((await overview(tenant.id)).statusCode).toBe(200);

    expect(await platformRows(tenant.id, 'support.access')).toHaveLength(before + 2);
    const own = await tenantRows(tenant.id, 'support.access');
    expect(own.length).toBeGreaterThanOrEqual(2);
    expect(own[0]).toMatchObject({ outcome: 'allow', actorUserId: operator.id });
    expect(own[0]?.metadata).toMatchObject({ view: 'overview' });

    // The owner reads it in the audit viewer.
    const viewer = await api.get('/audit-events?action=support.access', owner);
    expect(viewer.statusCode).toBe(200);
    expect(viewer.json<AuditListResponse>().events.length).toBeGreaterThanOrEqual(2);
    await closeAllGrants(tenant.id);
  });

  it('is denied once the grant has expired', async () => {
    await closeAllGrants(tenant.id);
    await asTenant(runtime, tenant.id, (tx) =>
      tx.insert(supportGrant).values({
        tenantId: tenant.id,
        reason: 'Ya venció',
        grantedBy: uuidv7(),
        startsAt: sql`now() - interval '2 hours'`,
        expiresAt: sql`now() - interval '1 hour'`,
      }),
    );

    expect((await overview(tenant.id)).statusCode).toBe(403);
  });

  it('is denied once the owner revokes the grant', async () => {
    const grant = await openGrant();
    expect((await overview(tenant.id)).statusCode).toBe(200);

    await api.delete(`/support-grants/${grant.id}`, owner);

    expect((await overview(tenant.id)).statusCode).toBe(403);
  });

  it('does not use the grant of another organization', async () => {
    await closeAllGrants(tenant.id);
    const otherOwner = await signInAs(
      app,
      'support-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    await openGrant(clientFor(app, 'support-b'), otherOwner);

    expect((await overview(tenant.id)).statusCode).toBe(403);
    expect((await overview(other.id)).statusCode).toBe(200);
    await closeAllGrants(other.id);
  });

  it('answers 404 for an organization that does not exist, and needs a session', async () => {
    const missing = await overview(uuidv7());
    const anonymous = await app.inject({
      method: 'GET',
      url: `/operator/tenants/${tenant.id}/support/overview`,
      headers: platformHeaders(),
      remoteAddress: '10.95.0.2',
    });

    expect(missing.statusCode).toBe(404);
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('the database enforces the grant, not just the service', () => {
  const read = <T>(
    tenantId: string,
    fn: (tx: Parameters<Parameters<typeof harness.db.db.transaction>[0]>[0]) => Promise<T>,
  ) =>
    harness.db.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });

  it('shows the operator role no location or feature without an active grant', async () => {
    await closeAllGrants(tenant.id);

    expect(await read(tenant.id, (tx) => tx.select().from(location))).toEqual([]);
    expect(await read(tenant.id, (tx) => tx.select().from(tenantFeature))).toEqual([]);

    await openGrant();
    expect(await read(tenant.id, (tx) => tx.select().from(location))).toHaveLength(1);
    expect(await read(tenant.id, (tx) => tx.select().from(tenantFeature))).toHaveLength(1);
    await closeAllGrants(tenant.id);
  });

  it('does not let the operator role read or write the grants themselves', async () => {
    await expect(read(tenant.id, (tx) => tx.select().from(supportGrant))).rejects.toThrow();
    await expect(
      read(tenant.id, (tx) =>
        tx.insert(supportGrant).values({
          tenantId: tenant.id,
          reason: 'Me la doy yo mismo',
          grantedBy: operator.id,
          expiresAt: sql`now() + interval '1 hour'`,
        }),
      ),
    ).rejects.toThrow();
  });
});

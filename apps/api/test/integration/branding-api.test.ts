import type { AuditAction, BrandingResponse } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession;
let doctor: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'branding-api' });
  other = await createTestTenant(runtime, { slug: 'branding-api-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'branding-api');
  const make = async (roles: ('owner' | 'admin' | 'reception' | 'professional')[]) =>
    signInAs(
      app,
      'branding-api',
      await createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD }),
    );
  owner = await make(['owner']);
  admin = await make(['admin']);
  reception = await make(['reception']);
  doctor = await make(['professional']);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

const IDENTITY = {
  displayName: 'Centro Médico del Sur',
  shortName: 'Del Sur',
  primaryColor: '#0f766e',
  radius: 'lg',
  headingFont: 'lora',
};

async function auditRows(action: AuditAction = 'branding.updated') {
  return asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('GET /branding', () => {
  it('shows the neutral product default for an organization that never set one', async () => {
    const fresh = await createTestTenant(runtime, { slug: 'branding-fresh' });
    const session = await signInAs(
      app,
      'branding-fresh',
      await createTestUser(runtime, fresh.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );

    const response = await clientFor(app, 'branding-fresh').get('/branding', session);

    expect(response.json<BrandingResponse>().branding).toEqual({
      displayName: null,
      shortName: null,
      primaryRequested: '#0f766e',
      primaryEffective: '#0f766e',
      primaryForeground: '#ffffff',
      radius: 'md',
      headingFont: 'inter',
      logoUrl: null,
    });
  });

  it('is for owners and admins only', async () => {
    expect((await api.get('/branding', admin)).statusCode).toBe(200);
    expect((await api.get('/branding', reception)).statusCode).toBe(403);
    expect((await api.get('/branding', doctor)).statusCode).toBe(403);
    expect((await api.get('/branding', null)).statusCode).toBe(401);
  });
});

describe('PUT /branding', () => {
  it('saves the identity and answers with it, no contrast warning for an adequate palette', async () => {
    const response = await api.put('/branding', owner, IDENTITY);

    expect(response.statusCode).toBe(200);
    const body = response.json<BrandingResponse>();
    expect(body.branding).toMatchObject({
      displayName: 'Centro Médico del Sur',
      shortName: 'Del Sur',
      primaryRequested: '#0f766e',
      primaryEffective: '#0f766e',
      radius: 'lg',
      headingFont: 'lora',
    });
    expect(body.contrast).toMatchObject({ adjusted: false, warning: null });
    expect((await api.get('/branding', admin)).json<BrandingResponse>().branding.displayName).toBe(
      'Centro Médico del Sur',
    );
  });

  it('keeps a low-contrast color as chosen, warns, and uses an accessible variant', async () => {
    const response = await api.put('/branding', owner, { ...IDENTITY, primaryColor: '#FFD54F' });

    expect(response.statusCode).toBe(200);
    const body = response.json<BrandingResponse>();
    expect(body.branding.primaryRequested).toBe('#ffd54f');
    expect(body.branding.primaryEffective).not.toBe('#ffd54f');
    expect(body.contrast).toMatchObject({ adjusted: true, warning: 'branding.contrast_adjusted' });
    expect(body.contrast.ratio).toBeGreaterThanOrEqual(4.5);
    // The chosen color is what is stored.
    const [stored] = await asTenant(runtime, tenant.id, (tx) =>
      tx.select({ theme: tenantTable.theme }).from(tenantTable),
    );
    expect(stored?.theme['primaryRequested']).toBe('#ffd54f');
  });

  it('previews the accessible variant before saving, storing nothing', async () => {
    const before = (await api.get('/branding', owner)).json<BrandingResponse>().branding
      .primaryRequested;

    const response = await api.post('/branding/preview', owner, { primaryColor: '#ffeb3b' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requested: '#ffeb3b', adjusted: true });
    expect(
      (await api.get('/branding', owner)).json<BrandingResponse>().branding.primaryRequested,
    ).toBe(before);
  });

  it('audits the change with the values before and after, field by field', async () => {
    await api.put('/branding', owner, IDENTITY);

    await api.put('/branding', admin, { ...IDENTITY, displayName: 'Nuevo nombre', radius: 'sm' });

    const [row] = await auditRows();
    expect(row).toMatchObject({
      outcome: 'allow',
      actorUserId: admin.user.id,
      resourceType: 'tenant',
      metadata: {
        fields: ['displayName', 'radius'],
        displayName_before: 'Centro Médico del Sur',
        displayName_after: 'Nuevo nombre',
        radius_before: 'lg',
        radius_after: 'sm',
      },
    });
  });

  it('writes nothing and audits nothing when the identity did not change', async () => {
    await api.put('/branding', owner, IDENTITY);
    const before = (await auditRows()).length;

    const response = await api.put('/branding', owner, IDENTITY);

    expect(response.statusCode).toBe(200);
    expect((await auditRows()).length).toBe(before);
  });

  it('is refused to reception and professionals', async () => {
    for (const session of [reception, doctor]) {
      expect((await api.put('/branding', session, IDENTITY)).statusCode).toBe(403);
      expect(
        (await api.post('/branding/preview', session, { primaryColor: '#123456' })).statusCode,
      ).toBe(403);
    }
  });

  it.each([
    ['a tenant id', { ...IDENTITY, tenantId: 'x' }],
    ['a name that is empty', { ...IDENTITY, displayName: '   ' }],
    ['a name that is too long', { ...IDENTITY, displayName: 'x'.repeat(61) }],
    ['a short name that is too long', { ...IDENTITY, shortName: 'x'.repeat(17) }],
    ['a color that is not a color', { ...IDENTITY, primaryColor: 'azul' }],
    ['a radius outside the set', { ...IDENTITY, radius: 'huge' }],
    ['a font outside the curated set', { ...IDENTITY, headingFont: 'comic_sans' }],
    ['a missing field', { displayName: 'Solo nombre' }],
  ])('rejects %s', async (_name, body) => {
    expect((await api.put('/branding', owner, body)).statusCode).toBe(400);
  });

  it("changes only this organization's identity", async () => {
    await api.put('/branding', owner, { ...IDENTITY, displayName: 'Sólo nosotros' });

    const [theirs] = await asTenant(runtime, other.id, (tx) =>
      tx.select({ theme: tenantTable.theme }).from(tenantTable),
    );
    expect(theirs?.theme).toEqual({});
  });

  it('does not change what anyone is allowed to do', async () => {
    const before = (await api.get('/auth/me', reception)).json<{ permissions: string[] }>()
      .permissions;

    await api.put('/branding', owner, {
      ...IDENTITY,
      primaryColor: '#ff0000',
      displayName: 'Administrador',
    });

    expect(
      (await api.get('/auth/me', reception)).json<{ permissions: string[] }>().permissions,
    ).toEqual(before);
    expect((await api.get('/branding', reception)).statusCode).toBe(403);
  });

  it('is refused in a read-only organization, like any write', async () => {
    await asTenant(runtime, tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, tenant.id)),
    );
    try {
      expect((await api.put('/branding', owner, IDENTITY)).statusCode).toBe(402);
    } finally {
      await asTenant(runtime, tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, tenant.id)),
      );
    }
  });
});

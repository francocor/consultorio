import {
  DEFAULT_SHARED_TEMPLATES,
  type AuditAction,
  type SettingsDto,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let a: TestTenant;
let b: TestTenant;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession;
let professional: TestSession;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'settings-a' });
  b = await createTestTenant(runtime, { slug: 'settings-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'settings-a');
  const make = (roles: ('owner' | 'admin' | 'reception' | 'professional')[]) =>
    createTestUser(runtime, a.id, { roles, password: TEST_PASSWORD });
  owner = await signInAs(app, 'settings-a', await make(['owner']));
  admin = await signInAs(app, 'settings-a', await make(['admin']));
  reception = await signInAs(app, 'settings-a', await make(['reception']));
  professional = await signInAs(app, 'settings-a', await make(['professional']));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

async function rows(action: AuditAction, tenantId = a.id) {
  return asTenant(runtime, tenantId, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenantId), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

const read = async (session: TestSession = owner) =>
  (await api.get('/settings', session)).json<SettingsDto>();

describe('GET /settings', () => {
  it('gives every setting its safe default for a new organization', async () => {
    const fresh = await createTestTenant(runtime, { slug: 'settings-fresh' });
    const user = await createTestUser(runtime, fresh.id, {
      roles: ['owner'],
      password: TEST_PASSWORD,
    });
    const session = await signInAs(app, 'settings-fresh', user);

    const response = await clientFor(app, 'settings-fresh').get('/settings', session);

    expect(response.json()).toEqual({
      receptionSeesClinicalMetadata: false,
      clinicalSharing: false,
      sharedTemplates: [],
      require2fa: false,
      quietHours: { start: '21:00', end: '08:00' },
    });
  });

  it('is for owners and admins only', async () => {
    expect((await api.get('/settings', admin)).statusCode).toBe(200);
    expect((await api.get('/settings', reception)).statusCode).toBe(403);
    expect((await api.get('/settings', professional)).statusCode).toBe(403);
    expect((await api.get('/settings', null)).statusCode).toBe(401);
  });
});

describe('PATCH /settings: sharing', () => {
  it('seeds the shared scope without psychology when sharing is first enabled, and audits it', async () => {
    const response = await api.patch('/settings', owner, { clinicalSharing: true });

    expect(response.statusCode).toBe(200);
    const settings = response.json<SettingsDto>();
    expect(settings.clinicalSharing).toBe(true);
    expect(settings.sharedTemplates).toEqual([...DEFAULT_SHARED_TEMPLATES]);
    const [row] = await rows('sharing.changed');
    expect(row).toMatchObject({
      outcome: 'allow',
      resourceType: 'tenant',
      metadata: {
        clinicalSharing: true,
        added: [...DEFAULT_SHARED_TEMPLATES],
        removed: [],
      },
    });
  });

  it('refuses psychology without the explicit choice, and accepts it with it, audited', async () => {
    const without = await api.patch('/settings', owner, {
      sharedTemplates: [...DEFAULT_SHARED_TEMPLATES, 'psychology'],
    });
    expect(without.statusCode).toBe(400);
    expect(without.json<{ errors: { path: string; i18nKey: string }[] }>().errors).toEqual([
      { path: 'sharedTemplates', i18nKey: 'settings.psychology_confirmation_required' },
    ]);
    expect((await read()).sharedTemplates).not.toContain('psychology');

    const withChoice = await api.patch('/settings', owner, {
      sharedTemplates: [...DEFAULT_SHARED_TEMPLATES, 'psychology'],
      confirmPsychologySharing: true,
    });

    expect(withChoice.statusCode).toBe(200);
    expect(withChoice.json<SettingsDto>().sharedTemplates).toContain('psychology');
    const [row] = await rows('sharing.changed');
    expect(row).toMatchObject({ metadata: { added: ['psychology'], removed: [] } });
  });

  it('switches sharing off, keeps the scope, and the change is audited', async () => {
    const response = await api.patch('/settings', owner, { clinicalSharing: false });

    expect(response.statusCode).toBe(200);
    const settings = response.json<SettingsDto>();
    expect(settings.clinicalSharing).toBe(false);
    expect(settings.sharedTemplates).toContain('psychology');
    const [row] = await rows('sharing.changed');
    expect(row).toMatchObject({ metadata: { clinicalSharing: false, added: [], removed: [] } });
  });

  it('is what the clinical backstop reads: a professional transaction sees the change at once', async () => {
    await api.patch('/settings', owner, { clinicalSharing: true });
    const [stored] = await asTenant(runtime, a.id, (tx) =>
      tx.select({ settings: tenant.settings }).from(tenant),
    );

    expect(stored?.settings['clinicalSharing']).toBe(true);
    expect(stored?.settings['sharedTemplates']).toEqual(
      expect.arrayContaining([...DEFAULT_SHARED_TEMPLATES]),
    );
  });

  it('writes nothing and audits nothing when nothing changed', async () => {
    const before = (await rows('sharing.changed')).length;

    const response = await api.patch('/settings', owner, { clinicalSharing: true });

    expect(response.statusCode).toBe(200);
    expect((await rows('sharing.changed')).length).toBe(before);
  });
});

describe('PATCH /settings: other settings', () => {
  it('audits the reception metadata switch with its own action', async () => {
    const response = await api.patch('/settings', admin, { receptionSeesClinicalMetadata: true });

    expect(response.statusCode).toBe(200);
    expect(response.json<SettingsDto>().receptionSeesClinicalMetadata).toBe(true);
    const [row] = await rows('setting.reception_sees_clinical_metadata.changed');
    expect(row).toMatchObject({ outcome: 'allow', metadata: { enabled: true } });
  });

  it('stores the two-factor policy where sign-in reads it, and audits it', async () => {
    const response = await api.patch('/settings', owner, { require2fa: true });

    expect(response.statusCode).toBe(200);
    const me = await api.get('/auth/me', reception);
    expect(me.json<{ twoFactor: { required: boolean } }>().twoFactor.required).toBe(true);
    const [row] = await rows('setting.changed');
    expect(row).toMatchObject({ metadata: { setting: 'require_2fa', enabled: true } });
  });

  it('stores quiet hours and audits them', async () => {
    const response = await api.patch('/settings', owner, {
      quietHours: { start: '22:00', end: '07:30' },
    });

    expect(response.json<SettingsDto>().quietHours).toEqual({ start: '22:00', end: '07:30' });
    const [row] = await rows('setting.changed');
    expect(row).toMatchObject({
      metadata: { setting: 'quiet_hours', start: '22:00', end: '07:30' },
    });
  });

  it('refuses reception and professionals, and malformed bodies', async () => {
    expect((await api.patch('/settings', reception, { require2fa: false })).statusCode).toBe(403);
    expect((await api.patch('/settings', professional, { clinicalSharing: true })).statusCode).toBe(
      403,
    );
    expect((await api.patch('/settings', owner, {})).statusCode).toBe(400);
    expect((await api.patch('/settings', owner, { tenantId: b.id })).statusCode).toBe(400);
    expect(
      (await api.patch('/settings', owner, { sharedTemplates: ['cardiology'] })).statusCode,
    ).toBe(400);
  });

  it("never touches another organization's settings", async () => {
    const other = await asTenant(runtime, b.id, (tx) =>
      tx.select({ settings: tenant.settings }).from(tenant),
    );

    expect(other[0]?.settings).toEqual({});
  });
});

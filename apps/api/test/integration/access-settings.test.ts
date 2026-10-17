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
      notifications: {
        reminderLeadHours: [24],
        hideProfessional: false,
        hideAppointmentType: false,
      },
      onlineBooking: {
        minLeadHours: 2,
        horizonDays: 60,
        dailyCap: null,
        rescheduleDeadlineHours: 12,
        requireApproval: false,
      },
      waitlist: {
        entryExpiryDays: 60,
        offerWindowMinutes: 30,
        minOfferLeadMinutes: 60,
        maxActiveEntries: 5,
      },
      teleconsultation: { joinOpensMinutes: 15, noShowAfterMinutes: 15 },
      integrations: { whatsapp: true, video: true, einvoicing: false },
      billing: { lateFeeEnabled: false, lateFeeAmount: 0 },
      invoicing: { outageThresholdHours: 24 },
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

describe('PATCH /settings: the sections of the modules', () => {
  it('stores a partial change of one section, keeps the rest of it and audits the fields', async () => {
    const response = await api.patch('/settings', owner, {
      notifications: { reminderLeadHours: [48, 2], hideProfessional: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SettingsDto>().notifications).toEqual({
      reminderLeadHours: [48, 2],
      hideProfessional: true,
      hideAppointmentType: false,
    });
    const [row] = await rows('setting.changed');
    expect(row).toMatchObject({
      outcome: 'allow',
      metadata: {
        setting: 'notifications',
        changedFields: ['reminderLeadHours', 'hideProfessional'],
      },
    });
    // The values never reach the trail: only the names of the fields.
    expect(JSON.stringify(row?.metadata)).not.toContain('48');
    const [stored] = await asTenant(runtime, a.id, (tx) =>
      tx.select({ settings: tenant.settings }).from(tenant),
    );
    expect(stored?.settings['notifications']).toEqual({
      reminderLeadHours: [48, 2],
      hideProfessional: true,
      hideAppointmentType: false,
    });
    // The settings of the other keys survive the merge.
    expect(stored?.settings['require_2fa']).toBe(true);
  });

  it('applies a second change on top of the first, one section at a time', async () => {
    const response = await api.patch('/settings', admin, {
      waitlist: { offerWindowMinutes: 20 },
      onlineBooking: { requireApproval: true, dailyCap: 25 },
    });

    expect(response.statusCode, response.body).toBe(200);
    const settings = response.json<SettingsDto>();
    expect(settings.waitlist).toMatchObject({ offerWindowMinutes: 20, maxActiveEntries: 5 });
    expect(settings.onlineBooking).toMatchObject({
      requireApproval: true,
      dailyCap: 25,
      horizonDays: 60,
    });
    expect(settings.notifications.reminderLeadHours).toEqual([48, 2]);
    const entries = await rows('setting.changed');
    expect(entries.map((entry) => (entry.metadata as { setting?: string }).setting)).toEqual(
      expect.arrayContaining(['waitlist', 'onlineBooking']),
    );
  });

  it('writes nothing and audits nothing when a section value did not change', async () => {
    const before = (await rows('setting.changed')).length;

    const response = await api.patch('/settings', owner, { waitlist: { offerWindowMinutes: 20 } });

    expect(response.statusCode).toBe(200);
    expect((await rows('setting.changed')).length).toBe(before);
  });

  it('audits the WhatsApp switch under its own action as well', async () => {
    const response = await api.patch('/settings', owner, { integrations: { whatsapp: false } });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SettingsDto>().integrations).toEqual({
      whatsapp: false,
      video: true,
      einvoicing: false,
    });
    const [row] = await rows('notification.integration.changed');
    expect(row).toMatchObject({
      outcome: 'allow',
      metadata: { setting: 'integrations', field: 'whatsapp', enabled: false },
    });
    // The video switch has no action of its own: only the generic entry.
    const videoOff = await api.patch('/settings', owner, { integrations: { video: false } });
    expect(videoOff.statusCode).toBe(200);
    expect((await rows('notification.integration.changed')).length).toBe(1);
  });

  it('audits the e-invoicing switch as a change of the invoicing configuration', async () => {
    const { whatsapp, video } = (await read()).integrations;

    const response = await api.patch('/settings', owner, { integrations: { einvoicing: true } });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<SettingsDto>().integrations).toEqual({
      whatsapp,
      video,
      einvoicing: true,
    });
    const [row] = await rows('invoicing.config.changed');
    expect(row).toMatchObject({
      outcome: 'allow',
      metadata: { setting: 'integrations', field: 'einvoicing', enabled: true },
    });
    // Switching it off again is a change too, and the other switches are untouched.
    const off = await api.patch('/settings', owner, { integrations: { einvoicing: false } });
    expect(off.json<SettingsDto>().integrations).toEqual({ whatsapp, video, einvoicing: false });
    expect((await rows('invoicing.config.changed')).length).toBe(2);
  });

  it('stores the billing and invoicing sections, audits them, and refuses reception', async () => {
    const response = await api.patch('/settings', owner, {
      billing: { lateFeeEnabled: true, lateFeeAmount: 500_000 },
      invoicing: { outageThresholdHours: 48 },
    });

    expect(response.statusCode, response.body).toBe(200);
    const settings = response.json<SettingsDto>();
    expect(settings.billing).toEqual({ lateFeeEnabled: true, lateFeeAmount: 500_000 });
    expect(settings.invoicing).toEqual({ outageThresholdHours: 48 });
    const entries = await rows('setting.changed');
    expect(entries.map((entry) => (entry.metadata as { setting?: string }).setting)).toEqual(
      expect.arrayContaining(['billing', 'invoicing']),
    );
    // A fee is whole cents and never negative; a threshold is whole hours within a month.
    for (const body of [
      { billing: { lateFeeAmount: 12.5 } },
      { billing: { lateFeeAmount: -1 } },
      { invoicing: { outageThresholdHours: 0 } },
    ]) {
      expect((await api.patch('/settings', owner, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    }
    expect(
      (await api.patch('/settings', reception, { invoicing: { outageThresholdHours: 12 } }))
        .statusCode,
    ).toBe(403);
  });

  it('refuses an unknown section, an unknown field and an invalid value, and changes nothing', async () => {
    const before = (await read()).waitlist;

    const unknownSection = await api.patch('/settings', owner, { payroll: { enabled: true } });
    const unknownField = await api.patch('/settings', owner, { waitlist: { priority: 'high' } });
    const invalid = await api.patch('/settings', owner, { waitlist: { maxActiveEntries: 0 } });
    const tooManyReminders = await api.patch('/settings', owner, {
      notifications: { reminderLeadHours: [72, 48, 24, 2] },
    });

    for (const response of [unknownSection, unknownField, invalid, tooManyReminders]) {
      expect(response.statusCode, response.body).toBe(400);
    }
    expect((await read()).waitlist).toEqual(before);
  });

  it('denies reception and professionals the sections, and sends nothing to another organization', async () => {
    const attempt = { waitlist: { maxActiveEntries: 3 } };

    expect((await api.patch('/settings', reception, attempt)).statusCode).toBe(403);
    expect((await api.patch('/settings', professional, attempt)).statusCode).toBe(403);
    expect((await api.get('/settings', reception)).statusCode).toBe(403);
    const other = await asTenant(runtime, b.id, (tx) =>
      tx.select({ settings: tenant.settings }).from(tenant),
    );
    expect(other[0]?.settings).toEqual({});
  });
});

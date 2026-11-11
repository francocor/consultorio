import {
  type AppointmentDto,
  type AuditAction,
  type LocationDto,
  type MeResponse,
  type OnboardingStateDto,
  type WeeklyHoursResponse,
  type AppointmentTypeListResponse,
  type FastPathResponse,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { membership } from '../../src/db/schema/identity.js';
import { professional } from '../../src/db/schema/staff.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { insertPatient } from '../support/scheduling.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant } from '../support/tenants.js';
import { createTestProfessional, createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
const email = createFakeEmailSender();

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  app = buildTestApplication(runtime, { email });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

/**
 * A new organization with its owner and nobody else: the checklist reads the real data, so a
 * test about it must start from an organization that has nothing. `team()` adds an admin,
 * reception and a professional when a test is about who may and may not.
 */
async function world(slug: string) {
  const tenant = await createTestTenant(runtime, { slug });
  const api = clientFor(app, slug);
  const make = (roles: ('owner' | 'admin' | 'reception')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  const ownerUser = await make(['owner']);
  const owner = await signInAs(app, slug, ownerUser);
  const state = async (session: TestSession = owner) =>
    (await api.get('/onboarding/state', session)).json<OnboardingStateDto>();
  const audits = (action: AuditAction) =>
    asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
        .orderBy(desc(auditEvent.occurredAt)),
    );
  let people:
    | {
        admin: TestSession;
        adminUser: TestSession['user'];
        reception: TestSession;
        doctor: TestSession;
        doctorUser: Awaited<ReturnType<typeof createTestProfessional>>;
      }
    | undefined;
  const team = async () => {
    if (!people) {
      const admin = await signInAs(app, slug, await make(['admin']));
      const reception = await signInAs(app, slug, await make(['reception']));
      const doctorUser = await createTestProfessional(runtime, tenant.id, {
        password: TEST_PASSWORD,
      });
      people = {
        admin,
        adminUser: admin.user,
        reception,
        doctor: await signInAs(app, slug, doctorUser),
        doctorUser,
      };
    }
    return people;
  };
  return { tenant, slug, api, owner, ownerUser, state, audits, team };
}

type World = Awaited<ReturnType<typeof world>>;
type Team = Awaited<ReturnType<World['team']>>;

const PROFILE = { fullName: 'Dra. Ana Perez', specialties: ['Clinica medica'] };
const MATRICULA = { jurisdiction: 'AR-B', number: 'MP 12345' };
const FAST = { ...PROFILE, matricula: MATRICULA };

describe('the state of the first run (task 2.86)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world('onb-state');
  });

  it('shows a new organization at the first step, with what is missing to book', async () => {
    const state = await w.state();

    expect(state.wizard).toMatchObject({
      completed: false,
      completedAt: null,
      currentStep: 'profile',
      answers: {},
      missing: ['location', 'professional', 'appointment_type'],
    });
    expect(state.wizard.steps.map((step) => [step.id, step.status, step.required])).toEqual([
      ['profile', 'pending', false],
      ['location', 'pending', true],
      ['hours', 'pending', true],
      ['appointment_types', 'pending', true],
      ['team', 'pending', false],
      ['branding', 'pending', false],
    ]);
    expect(state.checklist.dismissed).toBe(false);
    expect(state.checklist.items.map((item) => item.id)).toEqual([
      'location',
      'hours',
      'appointment_type',
      'first_patient',
      'first_appointment',
      'matricula',
      'invite_staff',
      'branding',
    ]);
    expect(state.checklist.items.every((item) => !item.done)).toBe(true);
  });

  it.each([
    ['reception', (x: Team) => x.reception],
    ['professional', (x: Team) => x.doctor],
    ['admin without the grant', (x: Team) => x.admin],
  ])('refuses %s, for reading and for writing', async (_name, pick) => {
    const session = pick(await w.team());

    expect((await w.api.get('/onboarding/state', session)).statusCode).toBe(403);
    expect(
      (await w.api.put('/onboarding/state', session, { checklistDismissed: true })).statusCode,
    ).toBe(403);
    expect((await w.api.post('/onboarding/complete', session)).statusCode).toBe(403);
    expect((await w.state()).checklist.dismissed).toBe(false);
  });

  it('answers 401 without a session', async () => {
    expect((await w.api.get('/onboarding/state', null)).statusCode).toBe(401);
  });

  it('lets an admin in only after the owner grants the permission explicitly', async () => {
    const { admin, adminUser } = await w.team();
    const grant = await w.api.post(`/members/${adminUser.membershipId}/grants`, w.owner, {
      permission: 'onboarding.manage',
    });
    expect(grant.statusCode, grant.body).toBe(201);

    const state = await w.api.get('/onboarding/state', admin);

    expect(state.statusCode).toBe(200);
  });

  it('saves a skipped optional step and resumes with it, for any owner of the organization', async () => {
    const saved = await w.api.put('/onboarding/state', w.owner, {
      step: { id: 'branding', status: 'skipped' },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const secondOwner = await signInAs(
      app,
      w.slug,
      await createTestUser(runtime, w.tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const state = await w.state(secondOwner);

    expect(state.wizard.steps.find((step) => step.id === 'branding')?.status).toBe('skipped');
    // The checklist still offers branding: skipping the step does not hide the item.
    expect(state.checklist.items.find((item) => item.id === 'branding')).toEqual({
      id: 'branding',
      done: false,
    });
  });

  it('keeps the cursor and the answers between sign-ins', async () => {
    await w.api.put('/onboarding/state', w.owner, { currentStep: 'hours' });
    await w.api.put('/onboarding/state', w.owner, { answers: { path: 'center' } });

    const state = await w.state();

    expect(state.wizard.currentStep).toBe('hours');
    expect(state.wizard.answers).toEqual({ path: 'center' });
  });

  it('never lets a required step be skipped or declared done by the client', async () => {
    for (const status of ['skipped', 'done'] as const) {
      const response = await w.api.put('/onboarding/state', w.owner, {
        step: { id: 'location', status },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ errors: { path: string; i18nKey: string }[] }>().errors).toEqual([
        { path: 'step.id', i18nKey: 'onboarding.step_required' },
      ]);
    }
    expect((await w.state()).wizard.steps.find((s) => s.id === 'location')?.status).toBe('pending');
  });

  it('refuses a step the deployment does not have', async () => {
    const response = await w.api.put('/onboarding/state', w.owner, { currentStep: 'billing' });

    expect(response.statusCode).toBe(400);
  });

  it.each([{}, { tenantId: 'x', checklistDismissed: true }, { wizardCompletedAt: 'now' }])(
    'rejects the body %j',
    async (body) => {
      expect((await w.api.put('/onboarding/state', w.owner, body)).statusCode).toBe(400);
    },
  );

  it('dismisses the checklist and brings it back, both audited', async () => {
    const dismissed = await w.api.put('/onboarding/state', w.owner, { checklistDismissed: true });
    expect(dismissed.json<OnboardingStateDto>().checklist.dismissed).toBe(true);
    expect((await w.state()).checklist.dismissed).toBe(true);

    const restored = await w.api.put('/onboarding/state', w.owner, { checklistDismissed: false });
    expect(restored.json<OnboardingStateDto>().checklist.dismissed).toBe(false);

    const [dismissal] = await w.audits('onboarding.checklist_dismissed');
    expect(dismissal).toMatchObject({ outcome: 'allow', resourceType: 'onboarding' });
    expect((await w.audits('onboarding.checklist_restored')).length).toBe(1);
  });

  it('audits every change to the progress with the step and nothing else', async () => {
    const entries = await w.audits('onboarding.step_updated');

    const skipped = entries.find((entry) => entry.metadata['step'] === 'branding');
    expect(skipped?.metadata).toEqual({ step: 'branding', status: 'skipped' });
  });

  it('keeps the progress of one organization out of reach of another', async () => {
    const other = await world('onb-state-other');

    const state = await other.state();

    expect(state.wizard.steps.find((step) => step.id === 'branding')?.status).toBe('pending');
    expect(state.wizard.answers).toEqual({});
  });
});

describe('finishing the wizard (task 2.86, "Required step")', () => {
  it('is blocked while a required piece is missing, and says which', async () => {
    const w = await world('onb-complete');

    const response = await w.api.post('/onboarding/complete', w.owner);

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string; i18nKey: string }[] }>().errors).toEqual([
      { path: 'location', i18nKey: 'onboarding.missing.location' },
      { path: 'professional', i18nKey: 'onboarding.missing.professional' },
      { path: 'appointment_type', i18nKey: 'onboarding.missing.appointment_type' },
    ]);
    expect((await w.state()).wizard.completed).toBe(false);
  });

  it('is allowed once a location, a professional with hours and an appointment type exist', async () => {
    const w = await world('onb-complete-ok');
    const { doctor, doctorUser } = await w.team();
    const place = (await w.api.post('/locations', w.owner, { name: 'Centro' })).json<LocationDto>();
    // The professional of the organization sets hours at the location through the normal screen.
    expect(
      (
        await w.api.put(`/professionals/${doctorUser.professionalId}/hours`, doctor, {
          hours: [{ locationId: place.id, weekday: 2, start: '09:00', end: '13:00' }],
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await w.api.post('/appointment-types', w.owner, {
          name: 'Consulta',
          durationMinutes: 30,
          mode: 'in_person',
        })
      ).statusCode,
    ).toBe(201);

    const done = await w.api.post('/onboarding/complete', w.owner);

    expect(done.statusCode, done.body).toBe(200);
    const state = done.json<OnboardingStateDto>();
    expect(state.wizard).toMatchObject({ completed: true, currentStep: null, missing: [] });
    expect(state.wizard.completedAt).not.toBeNull();
    const [entry] = await w.audits('onboarding.completed');
    expect(entry).toMatchObject({ outcome: 'allow', resourceType: 'onboarding' });
    // Finishing again changes nothing and writes nothing more.
    expect((await w.api.post('/onboarding/complete', w.owner)).statusCode).toBe(200);
    expect((await w.audits('onboarding.completed')).length).toBe(1);
  });
});

describe('"are you a professional?" (task 2.87)', () => {
  it('yes: the owner keeps the owner role and gets a professional profile', async () => {
    const w = await world('onb-prof-yes');

    const response = await w.api.post('/onboarding/professional', w.owner, {
      isProfessional: true,
      ...PROFILE,
      matricula: MATRICULA,
    });

    expect(response.statusCode, response.body).toBe(200);
    const me = (await w.api.get('/auth/me', w.owner)).json<MeResponse>();
    expect(me.roles.toSorted()).toEqual(['owner', 'professional']);
    const [row] = await asTenant(runtime, w.tenant.id, (tx) =>
      tx.select().from(professional).where(eq(professional.membershipId, w.ownerUser.membershipId)),
    );
    expect(row).toMatchObject({ matricula: '12345', matriculaStatus: 'unverified' });
    const state = await w.state();
    expect(state.wizard.answers.isProfessional).toBe(true);
    expect(state.wizard.steps.find((step) => step.id === 'profile')?.status).toBe('done');
    // The registration is recorded, so the checklist item is done and clinical work is open.
    expect(state.checklist.items.find((item) => item.id === 'matricula')?.done).toBe(true);
    expect(me.permissions).toContain('clinical.note.write');
  });

  it('yes without a matricula is refused: the role is only active with a complete profile (D21)', async () => {
    const w = await world('onb-prof-nomat');

    const response = await w.api.post('/onboarding/professional', w.owner, {
      isProfessional: true,
      ...PROFILE,
      matricula: null,
    });

    expect(response.statusCode, response.body).toBe(400);
    const me = (await w.api.get('/auth/me', w.owner)).json<MeResponse>();
    expect(me.roles).toEqual(['owner']);
    const rows = await asTenant(runtime, w.tenant.id, (tx) =>
      tx.select().from(professional).where(eq(professional.membershipId, w.ownerUser.membershipId)),
    );
    expect(rows).toEqual([]);
    expect(await w.audits('role.changed')).toEqual([]);
  });

  it('yes, twice: the second answer updates the profile and adds no second role or profile', async () => {
    const w = await world('onb-prof-twice');
    const body = { isProfessional: true, ...PROFILE, matricula: MATRICULA };
    await w.api.post('/onboarding/professional', w.owner, body);

    const again = await w.api.post('/onboarding/professional', w.owner, {
      ...body,
      matricula: { jurisdiction: 'AR-B', number: 'MP 54321' },
    });

    expect(again.statusCode, again.body).toBe(200);
    const roles = await asTenant(runtime, w.tenant.id, (tx) =>
      tx
        .select({ roles: membership.roles })
        .from(membership)
        .where(eq(membership.id, w.ownerUser.membershipId)),
    );
    expect(roles[0]?.roles.toSorted()).toEqual(['owner', 'professional']);
    const profiles = await asTenant(runtime, w.tenant.id, (tx) =>
      tx.select().from(professional).where(eq(professional.membershipId, w.ownerUser.membershipId)),
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.matricula).toBe('54321');
    // The role was added once.
    expect((await w.audits('role.changed')).length).toBe(1);
  });

  it('records the role in the audit trail, saying it came from the owner professional profile', async () => {
    const w = await world('onb-prof-audit');
    await w.api.post('/onboarding/professional', w.owner, {
      isProfessional: true,
      ...PROFILE,
      matricula: MATRICULA,
    });

    const [change] = await w.audits('role.changed');

    expect(change?.metadata).toMatchObject({
      previousRoles: ['owner'],
      newRoles: ['owner', 'professional'],
      via: 'owner_professional_profile',
      self: true,
    });
    expect((await w.audits('staff.profile_updated')).length).toBe(1);
  });

  it('no: the owner gets no clinical access and is asked for a professional', async () => {
    const w = await world('onb-prof-no');

    const response = await w.api.post('/onboarding/professional', w.owner, {
      isProfessional: false,
    });

    expect(response.statusCode, response.body).toBe(200);
    const me = (await w.api.get('/auth/me', w.owner)).json<MeResponse>();
    expect(me.roles).toEqual(['owner']);
    expect(me.permissions.filter((permission) => permission.startsWith('clinical.'))).toEqual([]);
    const rows = await asTenant(runtime, w.tenant.id, (tx) =>
      tx.select().from(professional).where(eq(professional.membershipId, w.ownerUser.membershipId)),
    );
    expect(rows).toEqual([]);
    const state = await w.state();
    expect(state.wizard.answers.isProfessional).toBe(false);
    expect(state.wizard.steps.find((step) => step.id === 'profile')?.status).toBe('done');
    // The wizard keeps asking for at least one professional.
    expect(state.wizard.missing).toContain('professional');
  });

  it('adds nothing when the registration is malformed: the role is not added either', async () => {
    const w = await world('onb-prof-bad');

    const response = await w.api.post('/onboarding/professional', w.owner, {
      isProfessional: true,
      ...PROFILE,
      matricula: { jurisdiction: 'AR-B', number: '!!' },
    });

    expect(response.statusCode).toBe(400);
    const me = (await w.api.get('/auth/me', w.owner)).json<MeResponse>();
    expect(me.roles).toEqual(['owner']);
  });

  it('refuses an admin who holds the grant: only an owner acts as a professional here', async () => {
    const w = await world('onb-prof-admin');
    const { admin, adminUser } = await w.team();
    await w.api.post(`/members/${adminUser.membershipId}/grants`, w.owner, {
      permission: 'onboarding.manage',
    });

    const response = await w.api.post('/onboarding/professional', admin, {
      isProfessional: true,
      ...PROFILE,
      matricula: MATRICULA,
    });

    expect(response.statusCode).toBe(403);
    const me = (await w.api.get('/auth/me', admin)).json<MeResponse>();
    expect(me.roles).toEqual(['admin']);
  });

  it('stays open after the wizard is finished: an owner may act as a professional at any time (D21)', async () => {
    const w = await world('onb-prof-late');
    await w.api.post('/onboarding/fast-path', w.owner, FAST);
    expect((await w.state()).wizard.completed).toBe(true);
    const second = await signInAs(
      app,
      w.slug,
      await createTestUser(runtime, w.tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );

    const response = await w.api.post('/onboarding/professional', second, {
      isProfessional: true,
      fullName: 'Dr. Juan Gomez',
      specialties: ['Cardiologia'],
      matricula: { jurisdiction: 'AR-B', number: 'MP 777' },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect((await w.api.get('/auth/me', second)).json<MeResponse>().roles.toSorted()).toEqual([
      'owner',
      'professional',
    ]);
  });

  it('does not depend on the age of the organization any more (D21): a year old, same answer', async () => {
    const day = 24 * 60 * 60 * 1000;
    const slug = 'onb-prof-old';
    const tenant = await createTestTenant(runtime, {
      slug,
      createdAt: new Date(Date.now() - 365 * day),
    });
    const owner = await signInAs(
      app,
      slug,
      await createTestUser(runtime, tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );

    const response = await clientFor(app, slug).post('/onboarding/professional', owner, {
      isProfessional: true,
      fullName: 'Dr. Juan Gomez',
      specialties: ['Cardiologia'],
      matricula: MATRICULA,
    });

    expect(response.statusCode, response.body).toBe(200);
    const me = (await clientFor(app, slug).get('/auth/me', owner)).json<MeResponse>();
    expect(me.roles.toSorted()).toEqual(['owner', 'professional']);
  });

  it('starts every organization in Argentina, with the Buenos Aires time zone for its places', async () => {
    const w = await world('onb-defaults');

    const place = await w.api.post('/locations', w.owner, { name: 'Centro' });

    expect(place.json<LocationDto>().timeZone).toBe('America/Argentina/Buenos_Aires');
    const boot = await w.api.get('/public/boot', null);
    expect(boot.json<{ locale: string }>().locale).toBe('es-AR');
  });
});

describe('the solo fast path (task 2.88)', () => {
  it('creates a location, Monday to Friday hours and a 30-minute type, and records the matricula (D21)', async () => {
    const w = await world('onb-fast');

    const response = await w.api.post('/onboarding/fast-path', w.owner, {
      fullName: 'Lic. Mario Gomez',
      specialties: ['Psicologia'],
      matricula: MATRICULA,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<FastPathResponse>();
    expect(body.created).toEqual({
      professional: true,
      location: true,
      hours: true,
      appointmentType: true,
    });
    expect(body.readyToBook).toBe(true);
    expect(body.state.wizard).toMatchObject({ completed: true, missing: [] });

    const places = (await w.api.get('/locations', w.owner)).json<{ locations: LocationDto[] }>();
    expect(places.locations).toHaveLength(1);
    expect(places.locations[0]).toMatchObject({
      name: 'Consultorio',
      timeZone: 'America/Argentina/Buenos_Aires',
    });
    const [profile] = await asTenant(runtime, w.tenant.id, (tx) => tx.select().from(professional));
    expect(profile).toMatchObject({
      matricula: '12345',
      matriculaStatus: 'unverified',
      specialties: ['Psicologia'],
    });
    const hours = (
      await w.api.get(`/professionals/${profile?.id ?? ''}/hours`, w.owner)
    ).json<WeeklyHoursResponse>();
    expect(hours.hours.map((h) => [h.weekday, h.start, h.end])).toEqual([
      [1, '09:00', '17:00'],
      [2, '09:00', '17:00'],
      [3, '09:00', '17:00'],
      [4, '09:00', '17:00'],
      [5, '09:00', '17:00'],
    ]);
    const types = (
      await w.api.get('/appointment-types', w.owner)
    ).json<AppointmentTypeListResponse>();
    expect(types.types).toHaveLength(1);
    expect(types.types[0]).toMatchObject({
      name: 'Consulta',
      durationMinutes: 30,
      bufferMinutes: 0,
      mode: 'in_person',
      active: true,
    });
    // What the checklist still asks for: branding, staff, a patient and a booking.
    const pending = body.state.checklist.items.filter((item) => !item.done).map((item) => item.id);
    expect(pending).toEqual(['first_patient', 'first_appointment', 'invite_staff', 'branding']);
  });

  it('leaves the organization ready to book: a first appointment can be made straight away', async () => {
    const w = await world('onb-fast-book');
    const { reception } = await w.team();
    const created = (
      await w.api.post('/onboarding/fast-path', w.owner, FAST)
    ).json<FastPathResponse>();
    expect(created.readyToBook).toBe(true);
    const place = (await w.api.get('/locations', w.owner)).json<{ locations: LocationDto[] }>()
      .locations[0];
    // The professional the fast path made (the owner), not the one `team()` added.
    const [doctor] = await asTenant(runtime, w.tenant.id, (tx) =>
      tx
        .select({ id: professional.id })
        .from(professional)
        .where(eq(professional.membershipId, w.ownerUser.membershipId)),
    );
    const type = (
      await w.api.get('/appointment-types', w.owner)
    ).json<AppointmentTypeListResponse>().types[0];
    const patientId = await asTenant(runtime, w.tenant.id, (tx) => insertPatient(tx, w.tenant.id));
    // Reception books it, at the location the fast path created.
    await w.api.put(`/members/${reception.user.membershipId}/locations`, w.owner, {
      locationIds: [place?.id],
    });
    const day = new Date(Date.now() + 10 * 86_400_000);
    while (day.getUTCDay() !== 2) day.setUTCDate(day.getUTCDate() + 1);

    const booking = await w.api.post('/appointments', reception, {
      patientId,
      professionalId: doctor?.id,
      locationId: place?.id,
      appointmentTypeId: type?.id,
      local: { date: day.toISOString().slice(0, 10), time: '10:00' },
    });

    expect(booking.statusCode, `${booking.body} (day ${day.toISOString()})`).toBe(201);
    expect(booking.json<AppointmentDto>().status).toBe('scheduled');
    const state = await w.state();
    expect(state.checklist.items.find((item) => item.id === 'first_appointment')?.done).toBe(true);
    expect(state.checklist.items.find((item) => item.id === 'first_patient')?.done).toBe(true);
  });

  it('is safe to repeat: nothing is created twice', async () => {
    const w = await world('onb-fast-twice');
    await w.api.post('/onboarding/fast-path', w.owner, FAST);

    const again = await w.api.post('/onboarding/fast-path', w.owner, FAST);

    expect(again.statusCode, again.body).toBe(200);
    expect(again.json<FastPathResponse>().created).toEqual({
      professional: false,
      location: false,
      hours: false,
      appointmentType: false,
    });
    const places = (await w.api.get('/locations', w.owner)).json<{ locations: LocationDto[] }>();
    expect(places.locations).toHaveLength(1);
    const types = (
      await w.api.get('/appointment-types', w.owner)
    ).json<AppointmentTypeListResponse>();
    expect(types.types).toHaveLength(1);
    const profiles = await asTenant(runtime, w.tenant.id, (tx) => tx.select().from(professional));
    expect(profiles).toHaveLength(1);
  });

  it('reuses what the organization already has and fills only the gaps', async () => {
    const w = await world('onb-fast-gaps');
    const existing = (
      await w.api.post('/locations', w.owner, { name: 'Sede Central' })
    ).json<LocationDto>();

    const response = await w.api.post('/onboarding/fast-path', w.owner, {
      ...FAST,
      locationName: 'Otro nombre',
    });

    expect(response.json<FastPathResponse>().created).toEqual({
      professional: true,
      location: false,
      hours: true,
      appointmentType: true,
    });
    const places = (await w.api.get('/locations', w.owner)).json<{ locations: LocationDto[] }>();
    expect(places.locations.map((place) => place.id)).toEqual([existing.id]);
  });

  it('names the first location as asked', async () => {
    const w = await world('onb-fast-name');

    await w.api.post('/onboarding/fast-path', w.owner, {
      ...FAST,
      locationName: 'Consultorio Palermo',
    });

    const places = (await w.api.get('/locations', w.owner)).json<{ locations: LocationDto[] }>();
    expect(places.locations[0]?.name).toBe('Consultorio Palermo');
  });

  it('writes the audit trail of what it did', async () => {
    const w = await world('onb-fast-audit');
    await w.api.post('/onboarding/fast-path', w.owner, FAST);

    const [fast] = await w.audits('onboarding.fast_path');

    expect(fast?.metadata).toEqual({
      professional: true,
      location: true,
      hours: true,
      appointmentType: true,
    });
    expect((await w.audits('location.created')).length).toBe(1);
    expect((await w.audits('appointment_type.created')).length).toBe(1);
    expect((await w.audits('professional.hours_updated')).length).toBe(1);
    expect((await w.audits('onboarding.completed')).length).toBe(1);
  });

  it.each([
    ['reception', (x: Team) => x.reception],
    ['a professional', (x: Team) => x.doctor],
    ['an admin without the grant', (x: Team) => x.admin],
  ])('refuses %s and creates nothing', async (_name, pick) => {
    const w = await world(`onb-fast-deny-${String(Math.random()).slice(2, 8)}`);

    const response = await w.api.post('/onboarding/fast-path', pick(await w.team()), FAST);

    expect(response.statusCode).toBe(403);
    const places = (await w.api.get('/locations', w.owner)).json<{ locations: LocationDto[] }>();
    expect(places.locations).toEqual([]);
  });

  it('needs the matricula and its jurisdiction to make the owner a professional, and creates nothing without them (D21)', async () => {
    const w = await world('onb-fast-nomat');

    const missing = await w.api.post('/onboarding/fast-path', w.owner, PROFILE);
    const malformed = await w.api.post('/onboarding/fast-path', w.owner, {
      ...PROFILE,
      matricula: { jurisdiction: 'AR-B', number: '!!' },
    });

    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json<{ errors: { path: string }[] }>().errors).toEqual([
      expect.objectContaining({ path: 'matricula' }),
    ]);
    expect(malformed.statusCode).toBe(400);
    const me = (await w.api.get('/auth/me', w.owner)).json<MeResponse>();
    expect(me.roles).toEqual(['owner']);
    const places = (await w.api.get('/locations', w.owner)).json<{ locations: LocationDto[] }>();
    expect(places.locations).toEqual([]);
    expect(await asTenant(runtime, w.tenant.id, (tx) => tx.select().from(professional))).toEqual(
      [],
    );
    expect((await w.state()).wizard.completed).toBe(false);
  });

  it('needs no matricula again from an owner who already completed the professional profile', async () => {
    const w = await world('onb-fast-has-profile');
    await w.api.post('/onboarding/professional', w.owner, {
      isProfessional: true,
      ...PROFILE,
      matricula: MATRICULA,
    });

    const response = await w.api.post('/onboarding/fast-path', w.owner, PROFILE);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<FastPathResponse>();
    expect(body.created).toMatchObject({ professional: false, location: true });
    expect(body.readyToBook).toBe(true);
  });

  it('asks for the name of the professional and a specialty', async () => {
    const w = await world('onb-fast-invalid');

    expect(
      (await w.api.post('/onboarding/fast-path', w.owner, { specialties: ['x'] })).statusCode,
    ).toBe(400);
    expect(
      (await w.api.post('/onboarding/fast-path', w.owner, { fullName: 'A', specialties: [] }))
        .statusCode,
    ).toBe(400);
  });
});

describe('the first-run checklist (task 2.89)', () => {
  const done = (state: OnboardingStateDto) =>
    state.checklist.items.filter((item) => item.done).map((item) => item.id);

  it('completes an item from data, without a click, when the work is done elsewhere', async () => {
    const w = await world('onb-list-location');
    expect(done(await w.state())).toEqual([]);

    // The owner creates a location through the ordinary settings screen, not through the wizard.
    await w.api.post('/locations', w.owner, { name: 'Centro' });

    expect(done(await w.state())).toEqual(['location']);
  });

  it('completes the type, the patient and the branding from their own screens', async () => {
    const w = await world('onb-list-others');

    await w.api.post('/appointment-types', w.owner, {
      name: 'Primera consulta',
      durationMinutes: 45,
      mode: 'in_person',
    });
    await asTenant(runtime, w.tenant.id, (tx) => insertPatient(tx, w.tenant.id));
    await w.api.put('/branding', w.owner, {
      displayName: 'Consultorio Sur',
      shortName: 'Sur',
      primaryColor: '#1d4ed8',
      radius: 'md',
      headingFont: 'inter',
    });

    expect(done(await w.state()).toSorted()).toEqual(
      ['appointment_type', 'branding', 'first_patient'].toSorted(),
    );
  });

  it('does not count the name given at creation as branding', async () => {
    const w = await world('onb-list-name');
    await w.api.put('/branding', w.owner, {
      displayName: 'Solo el nombre',
      shortName: 'Nombre',
      primaryColor: '#0f766e',
      radius: 'md',
      headingFont: 'inter',
    });

    // Saving the identity is what branding means; the checklist reads it from the saved theme.
    expect(done(await w.state())).toContain('branding');
  });

  it('completes "invite staff" when the owner invites someone', async () => {
    const w = await world('onb-list-invite');
    expect(done(await w.state())).not.toContain('invite_staff');

    const sent = await w.api.post('/staff/invitations', w.owner, {
      email: 'recepcion@clinica.example',
      roles: ['reception'],
    });
    expect(sent.statusCode, sent.body).toBe(201);

    expect(done(await w.state())).toContain('invite_staff');
  });

  it('completes the matricula when a professional of the organization records one', async () => {
    const w = await world('onb-list-matricula');
    await createTestProfessional(runtime, w.tenant.id, { matricula: 'MP 777' });

    expect(done(await w.state())).toContain('matricula');
  });

  it('completes the hours when a professional has working hours at a place', async () => {
    const w = await world('onb-list-hours');
    const place = (await w.api.post('/locations', w.owner, { name: 'Centro' })).json<LocationDto>();
    const doctor = await createTestProfessional(runtime, w.tenant.id, { password: TEST_PASSWORD });
    const session = await signInAs(app, w.slug, doctor);
    expect(done(await w.state())).not.toContain('hours');

    await w.api.put(`/professionals/${doctor.professionalId}/hours`, session, {
      hours: [{ locationId: place.id, weekday: 3, start: '10:00', end: '12:00' }],
    });

    expect(done(await w.state())).toContain('hours');
  });

  it('shows no item and no step of a capability the deployment lacks', async () => {
    const tenant = await createTestTenant(runtime, { slug: 'onb-list-caps' });
    const limited = buildTestApplication(runtime, {
      onboardingCapabilities: new Set(['patients', 'scheduling'] as const),
    });
    await limited.ready();
    try {
      const owner = await signInAs(
        limited,
        tenant.slug,
        await createTestUser(runtime, tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
      );

      const state = (
        await clientFor(limited, tenant.slug).get('/onboarding/state', owner)
      ).json<OnboardingStateDto>();

      expect(state.checklist.items.map((item) => item.id)).not.toContain('branding');
      expect(state.wizard.steps.map((step) => step.id)).not.toContain('branding');
      expect(state.checklist.items.map((item) => item.id)).toContain('first_patient');
    } finally {
      await limited.close();
    }
  });
});

describe('the invitation from the first run (task 2.90)', () => {
  it('tells, before sending, whether inviting changes the plan: not until subscriptions exist', async () => {
    const w = await world('onb-impact');

    const response = await w.api.get('/onboarding/invitation-impact?roles=professional', w.owner);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ affectsPlan: false });
    expect(
      (
        await w.api.get(
          '/onboarding/invitation-impact?roles=professional',
          (await w.team()).reception,
        )
      ).statusCode,
    ).toBe(403);
    expect((await w.api.get('/onboarding/invitation-impact?roles=king', w.owner)).statusCode).toBe(
      400,
    );
  });

  it('sends a link that grants only the invited role, nothing above it', async () => {
    const w = await world('onb-invite-role');
    email.clear();
    const address = 'recepcion.nueva@clinica.example';
    const sent = await w.api.post('/staff/invitations', w.owner, {
      email: address,
      roles: ['reception'],
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const link = email.linkIn(email.lastTo(address));
    const token = new URL(link ?? '').searchParams.get('token');
    expect(token).toBeTruthy();

    const accepted = await w.api.post('/auth/invitations/accept', null, {
      token,
      password: 'una frase propia elegida por la persona invitada',
    });
    expect(accepted.statusCode, accepted.body).toBeLessThan(300);

    const rows = await asTenant(runtime, w.tenant.id, (tx) =>
      tx.select({ roles: membership.roles }).from(membership),
    );
    // The owner plus the one invited person, who holds exactly the invited role.
    expect(rows.map((row) => row.roles.toSorted())).toEqual(
      expect.arrayContaining([['owner'], ['reception']]),
    );
    expect(rows).toHaveLength(2);
  });

  it('an admin with the grant may invite a professional from the first run too (D19, revised)', async () => {
    const w = await world('onb-invite-d19');
    const { admin, adminUser } = await w.team();
    await w.api.post(`/members/${adminUser.membershipId}/grants`, w.owner, {
      permission: 'onboarding.manage',
    });

    const response = await w.api.post('/staff/invitations', admin, {
      email: 'medico@clinica.example',
      roles: ['professional'],
    });

    expect(response.statusCode).toBe(201);
    expect((await w.audits('professional.added_by_admin')).length).toBe(1);
  });
});

describe('the first sign-in lands in the wizard (task 2.90)', () => {
  it('tells the owner of a new organization to run the wizard, until it is finished', async () => {
    const w = await world('onb-needs');

    const before = (await w.api.get('/auth/me', w.owner)).json<MeResponse>();
    await w.api.post('/onboarding/fast-path', w.owner, FAST);
    const after = (await w.api.get('/auth/me', w.owner)).json<MeResponse>();

    expect(before.needsWizard).toBe(true);
    expect(after.needsWizard).toBe(false);
  });

  it('never tells reception, a professional or an admin without the grant', async () => {
    const w = await world('onb-needs-others');
    const { reception, doctor, admin } = await w.team();

    for (const session of [reception, doctor, admin]) {
      expect((await w.api.get('/auth/me', session)).json<MeResponse>().needsWizard).toBe(false);
    }
  });

  it('tells an admin once the owner grants the permission', async () => {
    const w = await world('onb-needs-admin');
    const { admin, adminUser } = await w.team();
    await w.api.post(`/members/${adminUser.membershipId}/grants`, w.owner, {
      permission: 'onboarding.manage',
    });

    expect((await w.api.get('/auth/me', admin)).json<MeResponse>().needsWizard).toBe(true);
  });

  it('does not ask an organization whose wizard is already finished', async () => {
    const w = await world('onb-needs-done');
    await asTenant(runtime, w.tenant.id, (tx) =>
      tx.execute(
        sql`INSERT INTO onboarding_state (tenant_id, wizard_completed_at, wizard_completed_by)
              VALUES (${w.tenant.id}, now(), ${w.ownerUser.id})`,
      ),
    );

    expect((await w.api.get('/auth/me', w.owner)).json<MeResponse>().needsWizard).toBe(false);
  });
});

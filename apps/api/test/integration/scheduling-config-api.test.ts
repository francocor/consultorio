import type {
  AppointmentTypeDto,
  AuditAction,
  BlockDto,
  DayOffDto,
  HolidayDto,
  HoursPeriodDto,
  LocationDto,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { scheduleBlock } from '../../src/db/schema/scheduling-config.js';
import { seedArHolidays } from '../../src/db/seed/ar-holidays.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional, createTestUser } from '../support/users.js';

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession;
let doctor: TestSession & { professionalId: string };
let colleague: TestSession & { professionalId: string };
let centro: string;
let madrid: string;
let foreignDoctor: string;
let foreignPlace: string;

async function professional(slug: string, owningTenant: TestTenant) {
  const created = await createTestProfessional(runtime, owningTenant.id, {
    password: TEST_PASSWORD,
  });
  return { ...(await signInAs(app, slug, created)), professionalId: created.professionalId };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  // The national catalog is platform data, loaded by the owner connection (as db:migrate does).
  const catalogDb = createOwnerDb(inject('ownerUrl'));
  await seedArHolidays(catalogDb.db, [2026]);
  await catalogDb.close();
  tenant = await createTestTenant(runtime, { slug: 'sched-cfg-a' });
  other = await createTestTenant(runtime, { slug: 'sched-cfg-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'sched-cfg-a');
  const make = (roles: ('owner' | 'admin' | 'reception')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  owner = await signInAs(app, 'sched-cfg-a', await make(['owner']));
  admin = await signInAs(app, 'sched-cfg-a', await make(['admin']));
  reception = await signInAs(app, 'sched-cfg-a', await make(['reception']));
  doctor = await professional('sched-cfg-a', tenant);
  colleague = await professional('sched-cfg-a', tenant);
  centro = (await api.post('/locations', owner, { name: 'Centro' })).json<LocationDto>().id;
  madrid = (
    await api.post('/locations', owner, { name: 'Madrid', timeZone: 'Europe/Madrid' })
  ).json<LocationDto>().id;

  const outsider = await professional('sched-cfg-b', other);
  foreignDoctor = outsider.professionalId;
  const foreignOwner = await signInAs(
    app,
    'sched-cfg-b',
    await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
  );
  foreignPlace = (
    await clientFor(app, 'sched-cfg-b').post('/locations', foreignOwner, { name: 'Ajena' })
  ).json<LocationDto>().id;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

async function auditRows(action: AuditAction) {
  return asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('appointment types', () => {
  const body = { name: 'First consultation', durationMinutes: 45, mode: 'in_person' };

  it('lets an owner or admin create a type, fills the defaults and audits it', async () => {
    const response = await api.post('/appointment-types', owner, body);

    expect(response.statusCode).toBe(201);
    const created = response.json<AppointmentTypeDto>();
    expect(created).toMatchObject({
      name: 'First consultation',
      durationMinutes: 45,
      bufferMinutes: 0,
      mode: 'in_person',
      requiresApproval: false,
      active: true,
    });
    const [row] = await auditRows('appointment_type.created');
    expect(row).toMatchObject({ outcome: 'allow', resourceType: 'appointment_type' });
    expect((await api.post('/appointment-types', admin, body)).statusCode).toBe(201);
  });

  it('refuses reception and professionals, and records the denial', async () => {
    const before = (await auditRows('access.denied')).length;

    expect((await api.post('/appointment-types', reception, body)).statusCode).toBe(403);
    expect((await api.post('/appointment-types', doctor, body)).statusCode).toBe(403);

    expect((await auditRows('access.denied')).length).toBe(before + 2);
  });

  it.each([0, -3])('rejects a duration of %i with a field error and creates nothing', async (n) => {
    const before = (await api.get('/appointment-types', owner)).json<{ types: unknown[] }>().types
      .length;

    const response = await api.post('/appointment-types', owner, { ...body, durationMinutes: n });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe('durationMinutes');
    const after = (await api.get('/appointment-types', owner)).json<{ types: unknown[] }>().types
      .length;
    expect(after).toBe(before);
  });

  it('can be restricted to professionals of the organization, and not to those of another', async () => {
    const ok = await api.post('/appointment-types', owner, {
      ...body,
      name: 'Restricted',
      professionalIds: [doctor.professionalId],
    });
    const foreign = await api.post('/appointment-types', owner, {
      ...body,
      name: 'Leaky',
      professionalIds: [foreignDoctor],
    });

    expect(ok.json<AppointmentTypeDto>().professionalIds).toEqual([doctor.professionalId]);
    expect(foreign.statusCode).toBe(404);
  });

  it('edits some fields, audits which ones (not the values), and refuses an empty edit', async () => {
    const created = (await api.post('/appointment-types', owner, body)).json<AppointmentTypeDto>();

    const response = await api.patch(`/appointment-types/${created.id}`, owner, {
      durationMinutes: 20,
      bufferMinutes: 10,
    });

    expect(response.json<AppointmentTypeDto>()).toMatchObject({
      durationMinutes: 20,
      bufferMinutes: 10,
      name: 'First consultation',
    });
    const [row] = await auditRows('appointment_type.updated');
    expect(row).toMatchObject({
      resourceId: created.id,
      metadata: { fields: ['bufferMinutes', 'durationMinutes'] },
    });
    expect((await api.patch(`/appointment-types/${created.id}`, owner, {})).statusCode).toBe(400);
    expect(
      (await api.patch(`/appointment-types/${created.id}`, reception, { name: 'x' })).statusCode,
    ).toBe(403);
  });

  it('deactivates and reactivates without deleting, and offers only active types by default', async () => {
    const created = (
      await api.post('/appointment-types', owner, { ...body, name: 'Control' })
    ).json<AppointmentTypeDto>();

    const deactivated = await api.post(`/appointment-types/${created.id}/deactivate`, owner);
    const again = await api.post(`/appointment-types/${created.id}/deactivate`, owner);
    const active = (await api.get('/appointment-types', reception)).json<{
      types: AppointmentTypeDto[];
    }>().types;
    const all = (await api.get('/appointment-types?includeInactive=true', owner)).json<{
      types: AppointmentTypeDto[];
    }>().types;

    expect(deactivated.json<AppointmentTypeDto>().active).toBe(false);
    expect(again.statusCode).toBe(200);
    expect(again.json<AppointmentTypeDto>().active).toBe(false);
    expect(active.some((type) => type.id === created.id)).toBe(false);
    expect(all.find((type) => type.id === created.id)?.active).toBe(false);

    const back = await api.post(`/appointment-types/${created.id}/reactivate`, owner);
    expect(back.json<AppointmentTypeDto>().active).toBe(true);
    expect((await auditRows('appointment_type.deactivated')).length).toBeGreaterThan(0);
    expect((await auditRows('appointment_type.reactivated')).length).toBeGreaterThan(0);
  });

  it('shows the active types to reception and professionals, but not to another organization', async () => {
    const own = await api.get('/appointment-types', doctor);
    const foreignOwner = await signInAs(
      app,
      'sched-cfg-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const theirs = await clientFor(app, 'sched-cfg-b').get('/appointment-types', foreignOwner);

    expect(own.statusCode).toBe(200);
    expect(own.json<{ types: unknown[] }>().types.length).toBeGreaterThan(0);
    expect(theirs.json<{ types: unknown[] }>().types).toEqual([]);
  });

  it('answers not found for the type of another organization', async () => {
    const foreignOwner = await signInAs(
      app,
      'sched-cfg-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const theirs = (
      await clientFor(app, 'sched-cfg-b').post('/appointment-types', foreignOwner, body)
    ).json<AppointmentTypeDto>();

    expect(
      (await api.patch(`/appointment-types/${theirs.id}`, owner, { name: 'x' })).statusCode,
    ).toBe(404);
    expect((await api.post(`/appointment-types/${theirs.id}/deactivate`, owner)).statusCode).toBe(
      404,
    );
  });
});

describe('blocks', () => {
  const vacation = {
    startsAt: '2026-12-20T00:00:00-03:00',
    endsAt: '2026-12-31T00:00:00-03:00',
    reason: 'Vacation',
  };

  it('blocks a professional, a whole location, or a professional at one location', async () => {
    const forDoctor = await api.post('/schedule-blocks', admin, {
      ...vacation,
      professionalId: doctor.professionalId,
    });
    const forPlace = await api.post('/schedule-blocks', admin, { ...vacation, locationId: centro });
    const both = await api.post('/schedule-blocks', admin, {
      ...vacation,
      professionalId: doctor.professionalId,
      locationId: centro,
    });

    expect(forDoctor.statusCode).toBe(201);
    const [block] = forDoctor.json<{ blocks: BlockDto[] }>().blocks;
    expect(block).toMatchObject({
      professionalId: doctor.professionalId,
      locationId: null,
      reason: 'Vacation',
      seriesId: null,
    });
    expect(forPlace.json<{ blocks: BlockDto[] }>().blocks[0]?.professionalId).toBeNull();
    expect(both.statusCode).toBe(201);
    expect((await auditRows('schedule_block.created')).length).toBeGreaterThanOrEqual(3);
  });

  it('refuses reception, a block that names nobody, and references to another organization', async () => {
    const request = { ...vacation, professionalId: doctor.professionalId };

    expect((await api.post('/schedule-blocks', reception, request)).statusCode).toBe(403);
    expect((await api.post('/schedule-blocks', owner, vacation)).statusCode).toBe(400);
    expect(
      (await api.post('/schedule-blocks', owner, { ...vacation, professionalId: foreignDoctor }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.post('/schedule-blocks', owner, { ...vacation, locationId: foreignPlace }))
        .statusCode,
    ).toBe(404);
  });

  it('lists blocks that touch a window, to everyone who can read the schedule', async () => {
    await api.post('/schedule-blocks', owner, {
      professionalId: colleague.professionalId,
      startsAt: '2027-03-01T09:00:00-03:00',
      endsAt: '2027-03-01T12:00:00-03:00',
      reason: 'Course',
    });

    const inWindow = await api.get(
      `/schedule-blocks?professionalId=${colleague.professionalId}&from=2027-03-01T00:00:00Z&to=2027-03-02T00:00:00Z`,
      reception,
    );
    const outside = await api.get(
      `/schedule-blocks?professionalId=${colleague.professionalId}&from=2027-04-01T00:00:00Z&to=2027-04-02T00:00:00Z`,
      reception,
    );

    expect(inWindow.json<{ blocks: BlockDto[] }>().blocks.map((b) => b.reason)).toEqual(['Course']);
    expect(outside.json<{ blocks: BlockDto[] }>().blocks).toEqual([]);
  });

  it('repeats a weekly block at the same local time, across a daylight saving change', async () => {
    const response = await api.post('/schedule-blocks', owner, {
      locationId: madrid,
      startsAt: '2026-03-21T10:00:00+01:00',
      endsAt: '2026-03-21T12:00:00+01:00',
      reason: 'Weekly meeting',
      recurrence: { frequency: 'weekly', count: 4 },
    });

    expect(response.statusCode).toBe(201);
    const { blocks } = response.json<{ blocks: BlockDto[] }>();
    expect(blocks).toHaveLength(4);
    expect(new Set(blocks.map((block) => block.seriesId)).size).toBe(1);
    expect(blocks[0]?.seriesId).not.toBeNull();
    // 21 and 28 March are winter time (UTC+1); 4 and 11 April are summer time (UTC+2).
    expect(blocks.map((block) => block.startsAt)).toEqual([
      '2026-03-21T09:00:00.000Z',
      '2026-03-28T09:00:00.000Z',
      '2026-04-04T08:00:00.000Z',
      '2026-04-11T08:00:00.000Z',
    ]);
    expect(blocks.map((block) => block.endsAt)).toEqual([
      '2026-03-21T11:00:00.000Z',
      '2026-03-28T11:00:00.000Z',
      '2026-04-04T10:00:00.000Z',
      '2026-04-11T10:00:00.000Z',
    ]);
  });

  it('needs a location to repeat a block, and accepts an end date instead of a count', async () => {
    const withoutPlace = await api.post('/schedule-blocks', owner, {
      professionalId: doctor.professionalId,
      startsAt: '2026-05-04T09:00:00-03:00',
      endsAt: '2026-05-04T10:00:00-03:00',
      reason: 'Weekly',
      recurrence: { frequency: 'weekly', count: 3 },
    });
    const until = await api.post('/schedule-blocks', owner, {
      locationId: centro,
      startsAt: '2026-05-04T09:00:00-03:00',
      endsAt: '2026-05-04T10:00:00-03:00',
      reason: 'Weekly',
      recurrence: { frequency: 'weekly', until: '2026-05-25' },
    });

    expect(withoutPlace.statusCode).toBe(400);
    expect(until.json<{ blocks: BlockDto[] }>().blocks).toHaveLength(4);
  });

  it('removes one occurrence, or the rest of a series, and keeps the rows', async () => {
    const created = (
      await api.post('/schedule-blocks', owner, {
        locationId: centro,
        startsAt: '2026-06-01T09:00:00-03:00',
        endsAt: '2026-06-01T10:00:00-03:00',
        reason: 'Series',
        recurrence: { frequency: 'weekly', count: 4 },
      })
    ).json<{ blocks: BlockDto[] }>().blocks;
    const [first, second, third, fourth] = created;

    const one = await api.delete(`/schedule-blocks/${second?.id ?? ''}`, owner);
    const rest = await api.delete(`/schedule-blocks/${third?.id ?? ''}?scope=series`, owner);
    const listed = (
      await api.get(
        '/schedule-blocks?from=2026-06-01T00:00:00-03:00&to=2026-07-01T00:00:00-03:00',
        owner,
      )
    ).json<{ blocks: BlockDto[] }>().blocks;
    const stored = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(scheduleBlock)
        .where(eq(scheduleBlock.seriesId, first?.seriesId ?? '')),
    );

    expect(one.statusCode).toBe(204);
    expect(rest.statusCode).toBe(204);
    expect(listed.map((block) => block.id)).toEqual([first?.id]);
    expect(stored).toHaveLength(4);
    expect(
      stored
        .filter((row) => row.removedAt !== null)
        .map((row) => row.id)
        .sort(),
    ).toEqual([second?.id, third?.id, fourth?.id].sort());
    expect((await auditRows('schedule_block.removed')).length).toBeGreaterThanOrEqual(2);
    expect((await api.delete(`/schedule-blocks/${first?.id ?? ''}`, reception)).statusCode).toBe(
      403,
    );
    expect((await api.delete(`/schedule-blocks/${second?.id ?? ''}`, owner)).statusCode).toBe(404);
  });
});

describe('days off and the holiday calendar', () => {
  const holidays = async (year: number, by: TestSession = reception) =>
    (await api.get(`/holidays?year=${String(year)}`, by)).json<{ holidays: HolidayDto[] }>()
      .holidays;

  it('merges the national catalog with the days the organization adds', async () => {
    const created = await api.post('/days-off', owner, {
      day: '2026-09-17',
      name: 'Local holiday',
    });

    expect(created.statusCode).toBe(201);
    const list = await holidays(2026);
    expect(list.find((h) => h.day === '2026-12-25')).toMatchObject({
      source: 'national',
      locationId: null,
    });
    expect(list.find((h) => h.day === '2026-09-17')).toMatchObject({
      name: 'Local holiday',
      source: 'organization',
      dayOffId: created.json<DayOffDto>().id,
    });
    expect(list.map((h) => h.day)).toEqual([...list.map((h) => h.day)].sort());
    expect((await auditRows('day_off.created')).length).toBeGreaterThan(0);
  });

  it('keeps the organization days off out of the catalog and out of other organizations', async () => {
    const foreignOwner = await signInAs(
      app,
      'sched-cfg-b',
      await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
    );
    const theirs = (
      await clientFor(app, 'sched-cfg-b').get('/holidays?year=2026', foreignOwner)
    ).json<{ holidays: HolidayDto[] }>().holidays;

    expect(theirs.some((h) => h.source === 'organization')).toBe(false);
    expect(theirs.some((h) => h.day === '2026-12-25')).toBe(true);
  });

  it('allows a day off for one location, refuses duplicates and other organizations locations', async () => {
    const one = await api.post('/days-off', owner, {
      day: '2026-10-12',
      name: 'Closure',
      locationId: centro,
    });
    const duplicate = await api.post('/days-off', owner, {
      day: '2026-10-12',
      name: 'Again',
      locationId: centro,
    });
    const foreign = await api.post('/days-off', owner, {
      day: '2026-10-13',
      name: 'Leaky',
      locationId: foreignPlace,
    });

    expect(one.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
    expect(foreign.statusCode).toBe(404);
  });

  it('removes a day off without deleting it, and refuses reception', async () => {
    const created = (
      await api.post('/days-off', owner, { day: '2026-11-02', name: 'Bridge' })
    ).json<DayOffDto>();

    expect((await api.delete(`/days-off/${created.id}`, reception)).statusCode).toBe(403);
    expect((await api.delete(`/days-off/${created.id}`, owner)).statusCode).toBe(204);
    expect((await holidays(2026)).some((h) => h.dayOffId === created.id)).toBe(false);
    expect((await api.delete(`/days-off/${created.id}`, owner)).statusCode).toBe(404);
    expect((await auditRows('day_off.removed')).length).toBeGreaterThan(0);
    // The same day can be added again afterwards.
    expect(
      (await api.post('/days-off', owner, { day: '2026-11-02', name: 'Bridge' })).statusCode,
    ).toBe(201);
  });
});

describe('working hours for a range of dates', () => {
  const periodUrl = (id: string) => `/professionals/${id}/hours-periods`;
  const monday = (locationId: string, start = '09:00', end = '13:00') => ({
    locationId,
    weekday: 1,
    start,
    end,
  });

  it('lets a professional replace their own hours for a range, and reads them back', async () => {
    const response = await api.post(periodUrl(doctor.professionalId), doctor, {
      dateFrom: '2026-12-01',
      dateTo: '2026-12-15',
      reason: 'Winter schedule',
      hours: [monday(centro), monday(centro, '14:00', '18:00')],
    });

    expect(response.statusCode).toBe(201);
    const listed = (await api.get(periodUrl(doctor.professionalId), reception)).json<{
      periods: HoursPeriodDto[];
    }>().periods;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      dateFrom: '2026-12-01',
      dateTo: '2026-12-15',
      reason: 'Winter schedule',
      hours: [monday(centro), monday(centro, '14:00', '18:00')],
    });
    expect((await auditRows('professional.hours_period_set')).length).toBeGreaterThan(0);
  });

  it('keeps a period that means "not working" with no intervals', async () => {
    const response = await api.post(periodUrl(colleague.professionalId), colleague, {
      dateFrom: '2027-01-04',
      dateTo: '2027-01-31',
      hours: [],
    });

    expect(response.statusCode).toBe(201);
    const listed = (await api.get(periodUrl(colleague.professionalId), colleague)).json<{
      periods: HoursPeriodDto[];
    }>().periods;
    expect(listed.map((period) => period.hours)).toEqual([[]]);
  });

  it('refuses periods that overlap, intervals that overlap, and other organizations locations', async () => {
    const overlapping = await api.post(periodUrl(doctor.professionalId), doctor, {
      dateFrom: '2026-12-10',
      dateTo: '2026-12-20',
      hours: [],
    });
    const badIntervals = await api.post(periodUrl(doctor.professionalId), doctor, {
      dateFrom: '2027-02-01',
      dateTo: '2027-02-10',
      hours: [monday(centro, '09:00', '13:00'), monday(madrid, '12:00', '16:00')],
    });
    const foreign = await api.post(periodUrl(doctor.professionalId), doctor, {
      dateFrom: '2027-02-01',
      dateTo: '2027-02-10',
      hours: [monday(foreignPlace)],
    });

    expect(overlapping.statusCode).toBe(409);
    expect(badIntervals.statusCode).toBe(400);
    expect(foreign.statusCode).toBe(404);
  });

  it('lets an admin edit anyone, and refuses another professional and reception', async () => {
    const request = { dateFrom: '2027-03-01', dateTo: '2027-03-05', hours: [] };

    expect((await api.post(periodUrl(doctor.professionalId), colleague, request)).statusCode).toBe(
      403,
    );
    expect((await api.post(periodUrl(doctor.professionalId), reception, request)).statusCode).toBe(
      403,
    );
    expect((await api.post(periodUrl(doctor.professionalId), admin, request)).statusCode).toBe(201);
    expect((await api.post(periodUrl(foreignDoctor), admin, request)).statusCode).toBe(404);
  });

  it('removes a period without deleting it, so the weekly hours apply again', async () => {
    const created = (
      await api.post(periodUrl(colleague.professionalId), colleague, {
        dateFrom: '2027-05-03',
        dateTo: '2027-05-07',
        hours: [],
      })
    ).json<HoursPeriodDto>();

    expect(
      (await api.delete(`${periodUrl(colleague.professionalId)}/${created.id}`, doctor)).statusCode,
    ).toBe(403);
    expect(
      (await api.delete(`${periodUrl(colleague.professionalId)}/${created.id}`, colleague))
        .statusCode,
    ).toBe(204);
    const listed = (await api.get(periodUrl(colleague.professionalId), colleague)).json<{
      periods: HoursPeriodDto[];
    }>().periods;
    expect(listed.some((period) => period.id === created.id)).toBe(false);
    expect((await auditRows('professional.hours_period_removed')).length).toBeGreaterThan(0);
  });
});

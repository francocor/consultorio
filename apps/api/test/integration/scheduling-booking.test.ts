import type {
  AppointmentDto,
  AppointmentTypeDto,
  AuditAction,
  LocationDto,
  Problem,
  SlotConflictExtension,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { appointment, appointmentEvent } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { buildTestApplication } from '../support/app.js';
import { insertPatient, occupancyOf } from '../support/scheduling.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from '../support/session.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional, createTestUser } from '../support/users.js';

/** Monday 2031-05-12 is the day the tests book; "now" is a week earlier. */
const DAY = '2031-05-12';
const NOW = new Date('2031-05-05T12:00:00.000Z');

let runtime: DbHandle;
let app: FastifyInstance;
let api: ReturnType<typeof clientFor>;
let tenant: TestTenant;
let other: TestTenant;
let owner: TestSession;
let admin: TestSession;
let reception: TestSession & { membershipId: string };
let doctor: TestSession & { professionalId: string };
let overbooker: { professionalId: string };
let centro: string;
let norte: string;
let consulta: string;
let withBuffer: string;
let patientId: string;
let foreign: { patientId: string; professionalId: string; locationId: string; typeId: string };

type ClientUser = Awaited<ReturnType<typeof createTestUser>>;
const session = async (user: ClientUser) => ({
  ...(await signInAs(app, 'sched-book', user)),
  membershipId: user.membershipId,
});

async function professionalWithHours(maxSimultaneous = 1) {
  const created = await createTestProfessional(runtime, tenant.id, { password: TEST_PASSWORD });
  const signedIn = await signInAs(app, 'sched-book', created);
  if (maxSimultaneous > 1) {
    await asTenant(runtime, tenant.id, (tx) =>
      tx.execute(
        sql`UPDATE professional SET max_simultaneous = ${maxSimultaneous} WHERE id = ${created.professionalId}`,
      ),
    );
  }
  // Mondays 09:00-13:00 at Centro, in the location zone (Buenos Aires, UTC-3).
  const hours = await api.put(`/professionals/${created.professionalId}/hours`, signedIn, {
    hours: [{ locationId: centro, weekday: 1, start: '09:00', end: '13:00' }],
  });
  expect(hours.statusCode).toBe(200);
  return { ...signedIn, professionalId: created.professionalId };
}

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'sched-book' });
  other = await createTestTenant(runtime, { slug: 'sched-book-b' });
  app = buildTestApplication(runtime, { clock: () => NOW });
  api = clientFor(app, 'sched-book');
  const make = (roles: ('owner' | 'admin' | 'reception')[]) =>
    createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
  owner = await signInAs(app, 'sched-book', await make(['owner']));
  admin = await signInAs(app, 'sched-book', await make(['admin']));
  reception = await session(await make(['reception']));
  centro = (await api.post('/locations', owner, { name: 'Centro' })).json<LocationDto>().id;
  norte = (await api.post('/locations', owner, { name: 'Norte' })).json<LocationDto>().id;
  await api.put(`/members/${reception.membershipId}/locations`, owner, { locationIds: [centro] });

  doctor = await professionalWithHours();
  overbooker = await professionalWithHours(2);
  consulta = (
    await api.post('/appointment-types', owner, {
      name: 'Consulta',
      durationMinutes: 30,
      mode: 'in_person',
    })
  ).json<AppointmentTypeDto>().id;
  withBuffer = (
    await api.post('/appointment-types', owner, {
      name: 'Con preparacion',
      durationMinutes: 30,
      bufferMinutes: 10,
      mode: 'in_person',
    })
  ).json<AppointmentTypeDto>().id;
  patientId = await asTenant(runtime, tenant.id, (tx) => insertPatient(tx, tenant.id));

  const foreignOwner = await signInAs(
    app,
    'sched-book-b',
    await createTestUser(runtime, other.id, { roles: ['owner'], password: TEST_PASSWORD }),
  );
  const foreignApi = clientFor(app, 'sched-book-b');
  const foreignDoctor = await createTestProfessional(runtime, other.id);
  foreign = {
    patientId: await asTenant(runtime, other.id, (tx) => insertPatient(tx, other.id)),
    professionalId: foreignDoctor.professionalId,
    locationId: (
      await foreignApi.post('/locations', foreignOwner, { name: 'Ajena' })
    ).json<LocationDto>().id,
    typeId: (
      await foreignApi.post('/appointment-types', foreignOwner, {
        name: 'Ajena',
        durationMinutes: 30,
        mode: 'in_person',
      })
    ).json<AppointmentTypeDto>().id,
  };
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

/** A patient of their own, so a test never depends on another test's appointments. */
const freshPatient = () => asTenant(runtime, tenant.id, (tx) => insertPatient(tx, tenant.id));

async function body(
  time: string,
  extra: Record<string, unknown> = {},
  who = doctor.professionalId,
) {
  return {
    patientId: await freshPatient(),
    professionalId: who,
    locationId: centro,
    appointmentTypeId: consulta,
    local: { date: DAY, time },
    ...extra,
  };
}

/** Each test books a day of its own so the appointments never collide with each other. */
const monday = (weeksAfter: number) =>
  new Date(Date.UTC(2031, 4, 12 + 7 * weeksAfter)).toISOString().slice(0, 10);

function dayBody(
  weeksAfter: number,
  time: string,
  extra: Record<string, unknown> = {},
  who = doctor.professionalId,
) {
  return {
    local: { date: monday(weeksAfter), time },
    professionalId: who,
    locationId: centro,
    appointmentTypeId: consulta,
    patientId,
    ...extra,
  };
}

async function audits(action: AuditAction) {
  return asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

describe('POST /appointments', () => {
  it('books a free slot: scheduled, creator and time recorded, occupancy and history written', async () => {
    const response = await api.post('/appointments', reception, await body('10:00'));

    expect(response.statusCode).toBe(201);
    const created = response.json<AppointmentDto>();
    expect(created).toMatchObject({
      status: 'scheduled',
      source: 'staff',
      startsAt: '2031-05-12T13:00:00.000Z',
      endsAt: '2031-05-12T13:30:00.000Z',
      bookedBy: reception.user.id,
      outOfHours: false,
      version: 1,
    });
    const events = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(appointmentEvent).where(eq(appointmentEvent.appointmentId, created.id)),
    );
    expect(events).toMatchObject([
      { kind: 'created', toStatus: 'scheduled', actorUserId: reception.user.id },
    ]);
    const occupancy = await asTenant(runtime, tenant.id, (tx) =>
      occupancyOf(tx, doctor.professionalId),
    );
    expect(occupancy.some((row) => row.appointment_id === created.id && row.active)).toBe(true);
    const [row] = await audits('appointment.created');
    expect(row).toMatchObject({
      outcome: 'allow',
      resourceId: created.id,
      actorUserId: reception.user.id,
    });
  });

  it('takes the creator and the organization from the session and ignores the body values', async () => {
    const response = await api.post('/appointments', reception, {
      ...(await body('09:00')),
      createdBy: '0190a000-0000-7000-8000-0000000000aa',
      bookedBy: '0190a000-0000-7000-8000-0000000000aa',
      tenantId: other.id,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<AppointmentDto>().bookedBy).toBe(reception.user.id);
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(appointment).where(eq(appointment.id, response.json<AppointmentDto>().id)),
    );
    expect(row?.tenantId).toBe(tenant.id);
  });

  it('rejects a double booking with the taken range and the next free slots, and creates nothing', async () => {
    const first = await api.post('/appointments', reception, dayBody(1, '10:00'));
    expect(first.statusCode).toBe(201);

    const clash = await api.post('/appointments', admin, dayBody(1, '10:15'));

    expect(clash.statusCode).toBe(409);
    const problem = clash.json<Problem & SlotConflictExtension>();
    expect(problem).toMatchObject({
      code: 'slot_taken',
      i18nKey: 'errors.slot_taken',
      conflict: { startsAt: '2031-05-19T13:00:00.000Z', endsAt: '2031-05-19T13:30:00.000Z' },
    });
    expect(problem.nextSlots.length).toBeGreaterThan(0);
    expect(problem.nextSlots[0]?.startsAt).toBe('2031-05-19T13:30:00.000Z');
    expect(problem.nextSlots.every((slot) => slot.startsAt !== '2031-05-19T13:00:00.000Z')).toBe(
      true,
    );
    // Nothing about the patient reaches the answer.
    expect(JSON.stringify(problem)).not.toContain(patientId);
    const count = await asTenant(runtime, tenant.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM appointment WHERE professional_id = ${doctor.professionalId} AND starts_at = '2031-05-19T13:15:00Z'`,
      ),
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it('allows back to back, and a buffer blocks the next start', async () => {
    expect((await api.post('/appointments', reception, dayBody(2, '10:00'))).statusCode).toBe(201);
    expect((await api.post('/appointments', reception, dayBody(2, '10:30'))).statusCode).toBe(201);

    const buffered = await api.post(
      '/appointments',
      reception,
      dayBody(3, '09:00', { appointmentTypeId: withBuffer }),
    );
    const tooSoon = await api.post('/appointments', reception, dayBody(3, '09:30'));
    const afterBuffer = await api.post('/appointments', reception, dayBody(3, '09:40'));

    expect(buffered.json<AppointmentDto>().bufferMinutes).toBe(10);
    expect(tooSoon.statusCode).toBe(409);
    expect(afterBuffer.statusCode).toBe(201);
  });

  it('rejects an appointment whose own buffer runs into a later one', async () => {
    await api.post('/appointments', reception, dayBody(4, '11:00'));

    const rejected = await api.post(
      '/appointments',
      reception,
      dayBody(4, '10:30', { appointmentTypeId: withBuffer }),
    );

    expect(rejected.statusCode).toBe(409);
  });

  it('lets an overbooking professional take two at once and not three', async () => {
    const make = () =>
      api.post('/appointments', reception, dayBody(5, '10:00', {}, overbooker.professionalId));

    const [first, second, third] = [await make(), await make(), await make()];

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(third.statusCode).toBe(409);
    const lanes = await asTenant(runtime, tenant.id, (tx) =>
      tx.execute<{ lane: number }>(
        sql`SELECT lane FROM appointment WHERE professional_id = ${overbooker.professionalId} AND starts_at = ${`${monday(5)}T13:00:00Z`}::timestamptz ORDER BY lane`,
      ),
    );
    expect(lanes.rows.map((row) => row.lane)).toEqual([1, 2]);
    // The limit is per instant, not per day: another hour is free.
    expect(
      (
        await api.post(
          '/appointments',
          reception,
          dayBody(5, '11:30', {}, overbooker.professionalId),
        )
      ).statusCode,
    ).toBe(201);
  });

  it('rejects a time outside the working hours, and a day the professional does not work', async () => {
    const early = await api.post('/appointments', reception, dayBody(6, '15:00'));
    const wrongDay = await api.post('/appointments', reception, {
      ...dayBody(6, '10:00'),
      local: { date: '2031-07-22', time: '10:00' },
    });

    expect(early.statusCode).toBe(400);
    expect(early.json<Problem>().errors).toEqual([
      { path: 'startsAt', i18nKey: 'scheduling.booking.outside_working_hours' },
    ]);
    expect(wrongDay.statusCode).toBe(400);
  });

  it('lets a user with the override book outside the hours with a reason, flagged and audited', async () => {
    const response = await api.post(
      '/appointments',
      admin,
      dayBody(7, '15:00', { overrideHours: { reason: 'Urgent follow-up' } }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json<AppointmentDto>().outOfHours).toBe(true);
    const [row] = await audits('appointment.overridden');
    expect(row).toMatchObject({
      resourceId: response.json<AppointmentDto>().id,
      actorUserId: admin.user.id,
      metadata: { kinds: ['out_of_hours'], overrideReason: 'Urgent follow-up' },
    });
    const stored = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(appointment).where(eq(appointment.id, response.json<AppointmentDto>().id)),
    );
    expect(stored[0]).toMatchObject({ outOfHours: true, overrideReason: 'Urgent follow-up' });
  });

  it('refuses the override to reception until it is granted, and takes effect when it is', async () => {
    const request = dayBody(8, '15:00', { overrideHours: { reason: 'Please' } });

    const denied = await api.post('/appointments', reception, request);
    const grant = await api.post(`/members/${reception.membershipId}/grants`, owner, {
      permission: 'scheduling.override_hours',
    });
    const allowed = await api.post('/appointments', reception, request);

    expect(denied.statusCode).toBe(403);
    expect(denied.json<Problem>().code).toBe('forbidden');
    expect(grant.statusCode).toBe(201);
    expect(allowed.statusCode).toBe(201);
    await api.delete(`/members/${reception.membershipId}/grants/scheduling.override_hours`, owner);
    expect(
      (
        await api.post(
          '/appointments',
          reception,
          dayBody(8, '16:00', { overrideHours: { reason: 'Again' } }),
        )
      ).statusCode,
    ).toBe(403);
  });

  it('rejects a block and a holiday, and lets the override book over them', async () => {
    const blockDay = '2031-08-04'; // a Monday
    const holiday = '2031-08-11'; // a Monday
    await api.post('/schedule-blocks', owner, {
      professionalId: doctor.professionalId,
      startsAt: `${blockDay}T00:00:00-03:00`,
      endsAt: `${blockDay}T23:59:00-03:00`,
      reason: 'Vacation',
    });
    await api.post('/days-off', owner, { day: holiday, name: 'Closure' });
    const book = (date: string, extra: Record<string, unknown> = {}) =>
      api.post('/appointments', admin, {
        ...dayBody(0, '10:00', extra),
        local: { date, time: '10:00' },
      });

    const blocked = await book(blockDay);
    const closed = await book(holiday);
    const forced = await book(blockDay, { overrideHours: { reason: 'Doctor is in' } });

    expect(blocked.json<Problem>().errors).toEqual([
      { path: 'startsAt', i18nKey: 'scheduling.booking.blocked' },
    ]);
    expect(closed.json<Problem>().errors).toEqual([
      { path: 'startsAt', i18nKey: 'scheduling.booking.holiday' },
    ]);
    expect(forced.statusCode).toBe(201);
  });

  it('never books a professional at two locations at once', async () => {
    const first = await api.post('/appointments', reception, dayBody(9, '10:00'));
    expect(first.statusCode).toBe(201);

    const elsewhere = await api.post('/appointments', admin, {
      ...dayBody(9, '10:00', { overrideHours: { reason: 'Covering Norte' } }),
      locationId: norte,
    });

    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json<Problem>().code).toBe('slot_taken');
  });

  it('answers not found for a patient, professional, location or type of another organization', async () => {
    for (const patch of [
      { patientId: foreign.patientId },
      { professionalId: foreign.professionalId },
      { locationId: foreign.locationId },
      { appointmentTypeId: foreign.typeId },
    ]) {
      const response = await api.post('/appointments', admin, {
        ...dayBody(10, '10:00'),
        ...patch,
      });
      expect(response.statusCode).toBe(404);
    }
    expect(
      (
        await asTenant(runtime, tenant.id, (tx) =>
          tx.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM appointment WHERE starts_at = ${`${monday(10)}T13:00:00Z`}::timestamptz`,
          ),
        )
      ).rows[0]?.n,
    ).toBe(0);
  });

  it('rejects a start in the past without the permission, and registers it with the grant', async () => {
    const past = { ...dayBody(0, '10:00'), local: { date: '2031-04-28', time: '10:00' } };

    const refused = await api.post('/appointments', reception, past);
    const registered = await api.post('/appointments', admin, past);

    expect(refused.statusCode).toBe(400);
    expect(refused.json<Problem>().errors).toEqual([
      { path: 'startsAt', i18nKey: 'scheduling.booking.in_past' },
    ]);
    // Admin holds the permission; the hours for that Monday are the weekly default.
    expect(registered.statusCode).toBe(201);
    const [row] = await audits('appointment.overridden');
    expect(row).toMatchObject({ metadata: { kinds: ['past'] } });
  });

  it('keeps reception to its own locations and denies the rest, recording the denial', async () => {
    const before = (await audits('access.denied')).length;

    const denied = await api.post('/appointments', reception, {
      ...dayBody(11, '10:00'),
      locationId: norte,
    });

    expect(denied.statusCode).toBe(403);
    expect((await audits('access.denied')).length).toBe(before + 1);
  });

  it('refuses an anonymous caller', async () => {
    const anonymous = await api.post('/appointments', null, dayBody(20, '10:00'));

    expect(anonymous.statusCode).toBe(401);
  });

  it('lets exactly one of two simultaneous requests win', async () => {
    const request = dayBody(21, '10:00');

    const [one, two] = await Promise.all([
      api.post('/appointments', reception, request),
      api.post('/appointments', admin, { ...request, patientId: await freshPatient() }),
    ]);

    expect([one.statusCode, two.statusCode].sort()).toEqual([201, 409]);
    const losing = [one, two].find((response) => response.statusCode === 409);
    expect(losing?.json<Problem>().code).toBe('slot_taken');
  });
});

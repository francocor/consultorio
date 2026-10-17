import type {
  AppointmentDto,
  AuditAction,
  CalendarEntryDto,
  CalendarResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { slotHold } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createSchedulingHttpWorld,
  type Doctor,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;
let other: SchedulingHttpWorld;
let norteDoctor: Doctor;
let norteAppointment: AppointmentDto;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-calendar' });
  other = await createSchedulingHttpWorld(runtime, { slug: 'sched-calendar-b' });
  // A professional who works at Norte, where reception does not.
  norteDoctor = await world.addProfessional();
  await world.api.put(`/professionals/${norteDoctor.professionalId}/hours`, norteDoctor, {
    hours: [{ locationId: world.norte, weekday: 1, start: '09:00', end: '13:00' }],
  });
  const response = await world.api.post('/appointments', world.admin, {
    ...(await world.bookingBody(1, '10:00')),
    professionalId: norteDoctor.professionalId,
    locationId: world.norte,
  });
  norteAppointment = response.json<AppointmentDto>();
});

afterAll(async () => {
  await world.close();
  await other.close();
  await runtime.close();
});

const window = (weeksAfter: number, days = 1) => {
  const from = `${world.monday(weeksAfter)}T00:00:00-03:00`;
  const to = new Date(Date.parse(from) + days * 86_400_000).toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
};

const feed = async (path: string, who = world.reception) =>
  (await world.api.get(`/appointments?${path}`, who)).json<CalendarResponse>();

async function auditCount(action: AuditAction) {
  const rows = await world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.length;
}

describe('the day view of a location', () => {
  it('lists the appointments of all professionals at the location of reception, and none of another organization', async () => {
    const mine = await world.book(2, '09:00');
    const colleagues = await world.book(2, '09:00', {
      professionalId: world.colleague.professionalId,
    });
    await other.book(2, '09:00');

    const response = await feed(`${window(2)}&locationId=${world.centro}`);

    const ids = response.appointments.map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([mine.id, colleagues.id]));
    expect(new Set(response.appointments.map((entry) => entry.professionalId))).toEqual(
      new Set([world.doctor.professionalId, world.colleague.professionalId]),
    );
    expect(response.appointments.every((entry) => entry.locationId === world.centro)).toBe(true);
    const otherIds = (
      await other.api.get(
        `/appointments?from=${encodeURIComponent(`${other.monday(2)}T00:00:00-03:00`)}&to=${encodeURIComponent(`${other.monday(3)}T00:00:00-03:00`)}`,
        other.reception,
      )
    ).json<CalendarResponse>();
    expect(otherIds.appointments.some((entry) => ids.includes(entry.id))).toBe(false);
  });

  it('shows administrative data only: name, type, status and time, nothing clinical', async () => {
    const created = await world.book(3, '09:00');

    const entry = (await feed(window(3))).appointments.find(
      (candidate) => candidate.id === created.id,
    );

    expect(entry).toMatchObject({
      status: 'scheduled',
      startsAt: created.startsAt,
      typeName: 'Consulta',
    });
    expect(entry?.patientName).toMatch(/^Paciente\d+, Nombre$/);
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        'appointmentTypeId',
        'bookedBy',
        'bufferMinutes',
        'endsAt',
        'id',
        'identityConfirmation',
        'identityConfirmed',
        'locationId',
        'outOfHours',
        'patientId',
        'patientName',
        'professionalId',
        'seriesId',
        'seriesIndex',
        'source',
        'startsAt',
        'status',
        'typeColor',
        'typeName',
        'version',
      ].sort(),
    );
  });

  it('keeps cancelled appointments visible with their status, and never lists a hold', async () => {
    const created = await world.book(4, '09:00');
    await world.api.post(`/appointments/${created.id}/cancel`, world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });
    const held = await world.api.post('/slot-holds', world.admin, {
      professionalId: world.doctor.professionalId,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      local: { date: world.monday(4), time: '11:00' },
    });
    expect(held.statusCode).toBe(201);

    const response = await feed(window(4));

    expect(response.appointments.find((entry) => entry.id === created.id)?.status).toBe(
      'cancelled',
    );
    expect(response.appointments).toHaveLength(1);
    const holds = await world.inTenant((tx) => tx.select().from(slotHold));
    expect(holds.length).toBeGreaterThan(0);
  });

  it('includes the blocks and holidays of the window so the grid can show them', async () => {
    await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.colleague.professionalId,
      startsAt: `${world.monday(5)}T09:00:00-03:00`,
      endsAt: `${world.monday(5)}T11:00:00-03:00`,
      reason: 'Course',
    });
    await world.api.post('/days-off', world.owner, { day: world.monday(5), name: 'Closure' });

    const response = await feed(window(5));

    expect(response.blocks).toHaveLength(1);
    expect(response.blocks[0]).toMatchObject({ reason: 'Course' });
    expect(response.holidays).toEqual([
      expect.objectContaining({ day: world.monday(5), name: 'Closure' }),
    ]);
  });

  it('validates the window', async () => {
    const wide = `from=${encodeURIComponent('2031-05-01T00:00:00Z')}&to=${encodeURIComponent('2031-09-01T00:00:00Z')}`;
    const backwards = `from=${encodeURIComponent('2031-05-02T00:00:00Z')}&to=${encodeURIComponent('2031-05-01T00:00:00Z')}`;

    expect((await world.api.get(`/appointments?${wide}`, world.reception)).statusCode).toBe(400);
    expect((await world.api.get(`/appointments?${backwards}`, world.reception)).statusCode).toBe(
      400,
    );
    expect((await world.api.get(`/appointments?${window(1)}`, null)).statusCode).toBe(401);
  });
});

describe('reception sees only the locations it works at', () => {
  it('hides the other location from the unfiltered feed, and denies asking for it (audited)', async () => {
    const all = await feed(window(1));
    const before = await auditCount('access.denied');

    const denied = await world.api.get(
      `/appointments?${window(1)}&locationId=${world.norte}`,
      world.reception,
    );

    expect(all.appointments.some((entry) => entry.id === norteAppointment.id)).toBe(false);
    expect(
      (await feed(window(1), world.admin)).appointments.some(
        (entry) => entry.id === norteAppointment.id,
      ),
    ).toBe(true);
    expect(denied.statusCode).toBe(403);
    expect(await auditCount('access.denied')).toBe(before + 1);
  });

  it('hides the detail of an appointment at another location, and shows one at its own', async () => {
    const mine = await world.book(6, '09:00');

    expect(
      (await world.api.get(`/appointments/${norteAppointment.id}`, world.reception)).statusCode,
    ).toBe(403);
    expect(
      (await world.api.get(`/appointments/${norteAppointment.id}/history`, world.reception))
        .statusCode,
    ).toBe(403);
    const detail = await world.api.get(`/appointments/${mine.id}`, world.reception);
    expect(detail.statusCode).toBe(200);
    expect(detail.json<CalendarEntryDto>()).toMatchObject({ id: mine.id, typeName: 'Consulta' });
    expect(
      (await world.api.get('/appointments/0190a000-0000-7000-8000-0000000000aa', world.reception))
        .statusCode,
    ).toBe(404);
  });
});

describe('a professional sees their own calendar by default', () => {
  it('lists only their own appointments when they name nobody', async () => {
    const mine = await world.book(7, '09:00');
    const colleagues = await world.book(7, '09:00', {
      professionalId: world.colleague.professionalId,
    });

    const response = await feed(window(7), world.doctor);

    const ids = response.appointments.map((entry) => entry.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(colleagues.id);
    expect(
      response.appointments.every((entry) => entry.professionalId === world.doctor.professionalId),
    ).toBe(true);
  });

  it('is denied when they ask for a colleague without a delegation, then allowed with it (audited), and denied again after revoking', async () => {
    const colleagues = await world.book(8, '09:00', {
      professionalId: world.colleague.professionalId,
    });
    const ask = () =>
      world.api.get(
        `/appointments?${window(8)}&professionalIds=${world.colleague.professionalId}`,
        world.doctor,
      );

    const before = await ask();
    await world.delegateCalendar(world.doctor, [world.colleague.professionalId]);
    const viewsBefore = await auditCount('appointment.calendar_viewed');
    const after = await ask();
    const viewsAfter = await auditCount('appointment.calendar_viewed');
    await world.revokeDelegation(world.doctor);
    const revoked = await ask();

    expect(before.statusCode).toBe(403);
    expect(after.statusCode).toBe(200);
    expect(after.json<CalendarResponse>().appointments.map((entry) => entry.id)).toContain(
      colleagues.id,
    );
    expect(viewsAfter).toBe(viewsBefore + 1);
    // The revocation takes effect with the very next request.
    expect(revoked.statusCode).toBe(403);
  });

  it('includes the delegated calendars in the default view, and audits it, but only while delegated', async () => {
    await world.delegateCalendar(world.doctor, [world.colleague.professionalId]);
    const mine = await world.book(10, '09:00');
    const colleagues = await world.book(10, '09:00', {
      professionalId: world.colleague.professionalId,
    });
    const views = await auditCount('appointment.calendar_viewed');

    const delegated = await feed(window(10), world.doctor);
    const viewsAfter = await auditCount('appointment.calendar_viewed');
    await world.revokeDelegation(world.doctor);
    const own = await feed(window(10), world.doctor);

    expect(delegated.appointments.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([mine.id, colleagues.id]),
    );
    expect(viewsAfter).toBe(views + 1);
    expect(own.appointments.map((entry) => entry.id)).toEqual([mine.id]);
  });

  it('does not audit a professional looking at their own calendar', async () => {
    const before = await auditCount('appointment.calendar_viewed');

    await feed(`${window(9)}&professionalIds=${world.doctor.professionalId}`, world.doctor);

    expect(await auditCount('appointment.calendar_viewed')).toBe(before);
  });

  it('does not audit reception or admin for working in every calendar of their locations', async () => {
    const before = await auditCount('appointment.calendar_viewed');

    await feed(window(9));
    await feed(window(9), world.admin);

    expect(await auditCount('appointment.calendar_viewed')).toBe(before);
  });
});

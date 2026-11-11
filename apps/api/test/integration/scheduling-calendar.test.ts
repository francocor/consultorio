import type {
  AppointmentDto,
  AppointmentTypeDto,
  AuditAction,
  CalendarEntryDto,
  CalendarResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { slotHold } from '../../src/db/schema/scheduling.js';
import { createBlockService } from '../../src/modules/scheduling/application/blocks.js';
import { createCalendar } from '../../src/modules/scheduling/application/calendar.js';
import { createHolidayService } from '../../src/modules/scheduling/application/holidays.js';
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
      mode: 'in_person',
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
        'mode',
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

  it('marks an appointment of a virtual type as virtual, in the feed and in its detail', async () => {
    const virtual = (
      await world.api.post('/appointment-types', world.owner, {
        name: 'Consulta virtual',
        durationMinutes: 30,
        mode: 'virtual',
      })
    ).json<AppointmentTypeDto>().id;
    const created = await world.book(15, '09:00', { appointmentTypeId: virtual });

    const entry = (await feed(window(15))).appointments.find(
      (candidate) => candidate.id === created.id,
    );
    const detail = await world.api.get(`/appointments/${created.id}`, world.reception);

    expect(entry?.mode).toBe('virtual');
    expect(detail.json<CalendarEntryDto>().mode).toBe('virtual');
  });

  it('keeps cancelled appointments visible with their status, and never lists a hold', async () => {
    const created = await world.book(4, '09:00');
    await world.act(created, 'cancel', world.reception, {
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

  it('says the answer is complete when it is, and cut short when the cap is reached', async () => {
    for (const time of ['09:00', '09:30', '10:00']) await world.book(12, time);
    const query = {
      from: `${world.monday(12)}T00:00:00-03:00`,
      to: new Date(Date.parse(`${world.monday(12)}T00:00:00-03:00`) + 86_400_000).toISOString(),
    };
    const actor = {
      kind: 'staff' as const,
      userId: world.admin.user.id,
      tenantId: world.tenant.id,
      membershipId: world.admin.membershipId,
      roles: ['admin' as const],
      grants: [],
      professionalId: null,
    };
    const auditActor = {
      userId: world.admin.user.id,
      actingRole: 'admin' as const,
      ip: null,
      userAgent: null,
      requestId: null,
    };
    const calendarWith = (maxEntries: number) =>
      createCalendar({
        blocks: createBlockService(),
        holidays: createHolidayService(),
        maxEntries,
      });
    const read = (maxEntries: number) =>
      world.inTenant((tx) => calendarWith(maxEntries).feed(tx, { query, actor, auditActor }));

    const roomy = await read(10);
    const exact = await read(3);
    const tight = await read(2);

    expect(roomy.appointments).toHaveLength(3);
    expect(roomy.truncated).toBe(false);
    // Exactly at the cap nothing is missing.
    expect(exact.appointments).toHaveLength(3);
    expect(exact.truncated).toBe(false);
    // One over the cap: the earliest ones are kept and the answer says it is not all of it.
    expect(tight.appointments).toHaveLength(2);
    expect(tight.truncated).toBe(true);
    expect((await feed(window(12))).truncated).toBe(false);
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

    // It looks like an appointment that does not exist (JD-S2 S6).
    expect(
      (await world.api.get(`/appointments/${norteAppointment.id}`, world.reception)).statusCode,
    ).toBe(404);
    expect(
      (await world.api.get(`/appointments/${norteAppointment.id}/history`, world.reception))
        .statusCode,
    ).toBe(404);
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

describe('the block list is scoped like the calendar feed (JD-S2 R3-1)', () => {
  const blockBody = (weeksAfter: number, extra: Record<string, string>, reason: string) => ({
    startsAt: `${world.monday(weeksAfter)}T09:00:00-03:00`,
    endsAt: `${world.monday(weeksAfter)}T11:00:00-03:00`,
    reason,
    ...extra,
  });
  const listBlocks = (query: string, who: Parameters<typeof world.api.get>[1]) =>
    world.api.get(`/schedule-blocks?${query}`, who);
  const reasons = (response: Awaited<ReturnType<typeof world.api.get>>) =>
    response.json<{ blocks: { reason: string }[] }>().blocks.map((block) => block.reason);

  it('keeps the blocks of a colleague from a professional without a delegation', async () => {
    await world.api.post(
      '/schedule-blocks',
      world.owner,
      blockBody(20, { professionalId: world.colleague.professionalId }, 'Colleague course'),
    );
    await world.api.post(
      '/schedule-blocks',
      world.owner,
      blockBody(20, { professionalId: world.doctor.professionalId }, 'Own course'),
    );
    const before = await auditCount('appointment.calendar_viewed');

    const unnamed = await listBlocks(window(20), world.doctor);
    const named = await listBlocks(
      `${window(20)}&professionalId=${world.colleague.professionalId}`,
      world.doctor,
    );
    const own = await listBlocks(
      `${window(20)}&professionalId=${world.doctor.professionalId}`,
      world.doctor,
    );

    expect(reasons(unnamed)).toEqual(['Own course']);
    // As the free time of a colleague's calendar: a refusal, not an empty list.
    expect(named.statusCode).toBe(403);
    expect(reasons(own)).toEqual(['Own course']);
    expect(await auditCount('appointment.calendar_viewed')).toBe(before);
  });

  it('gives them the blocks of a delegated calendar, audits the look, and stops when it is revoked', async () => {
    await world.api.post(
      '/schedule-blocks',
      world.owner,
      blockBody(21, { professionalId: world.colleague.professionalId }, 'Delegated course'),
    );
    const ask = () =>
      listBlocks(`${window(21)}&professionalId=${world.colleague.professionalId}`, world.doctor);

    await world.delegateCalendar(world.doctor, [world.colleague.professionalId]);
    const viewsBefore = await auditCount('appointment.calendar_viewed');
    const delegated = await ask();
    const viewsAfter = await auditCount('appointment.calendar_viewed');
    const byDefault = await listBlocks(window(21), world.doctor);
    const viewsDefault = await auditCount('appointment.calendar_viewed');
    await world.revokeDelegation(world.doctor);
    const revoked = await ask();
    const own = await listBlocks(window(21), world.doctor);

    expect(delegated.statusCode).toBe(200);
    expect(reasons(delegated)).toEqual(['Delegated course']);
    expect(viewsAfter).toBe(viewsBefore + 1);
    expect(reasons(byDefault)).toEqual(['Delegated course']);
    expect(viewsDefault).toBe(viewsAfter + 1);
    expect(revoked.statusCode).toBe(403);
    expect(reasons(own)).toEqual([]);
  });

  it('keeps the blocks of another location from reception, and denies asking for it (audited)', async () => {
    await world.api.post(
      '/schedule-blocks',
      world.owner,
      blockBody(22, { locationId: world.norte }, 'Norte closure'),
    );
    await world.api.post(
      '/schedule-blocks',
      world.owner,
      blockBody(22, { locationId: world.centro }, 'Centro closure'),
    );
    const before = await auditCount('access.denied');

    const all = await listBlocks(window(22), world.reception);
    const adminAll = await listBlocks(window(22), world.admin);
    const denied = await listBlocks(`${window(22)}&locationId=${world.norte}`, world.reception);
    const mine = await listBlocks(`${window(22)}&locationId=${world.centro}`, world.reception);

    expect(reasons(all)).toEqual(['Centro closure']);
    expect(reasons(adminAll).sort()).toEqual(['Centro closure', 'Norte closure']);
    expect(denied.statusCode).toBe(403);
    expect(await auditCount('access.denied')).toBe(before + 1);
    expect(reasons(mine)).toEqual(['Centro closure']);
  });
});

describe('looking at one appointment, its history or free time in a delegated calendar', () => {
  const availability = (professionalId: string, who: typeof world.doctor | typeof world.admin) =>
    world.api.get(
      `/availability?professionalId=${professionalId}&typeId=${world.consulta}&from=${world.monday(13)}&to=${world.monday(13)}`,
      who,
    );

  it('is audited as a calendar view, once for each look', async () => {
    await world.delegateCalendar(world.doctor, [world.colleague.professionalId]);
    try {
      const theirs = await world.book(13, '09:00', {
        professionalId: world.colleague.professionalId,
      });
      const before = await auditCount('appointment.calendar_viewed');

      const one = await world.api.get(`/appointments/${theirs.id}`, world.doctor);
      const afterOne = await auditCount('appointment.calendar_viewed');
      const history = await world.api.get(`/appointments/${theirs.id}/history`, world.doctor);
      const afterHistory = await auditCount('appointment.calendar_viewed');
      const free = await availability(world.colleague.professionalId, world.doctor);
      const afterFree = await auditCount('appointment.calendar_viewed');

      expect([one.statusCode, history.statusCode, free.statusCode]).toEqual([200, 200, 200]);
      expect([afterOne, afterHistory, afterFree]).toEqual([before + 1, before + 2, before + 3]);
    } finally {
      await world.revokeDelegation(world.doctor);
    }
  });

  it('is not audited in their own calendar, nor for reception and admin', async () => {
    const mine = await world.book(13, '10:00');
    const theirs = await world.book(13, '10:30', {
      professionalId: world.colleague.professionalId,
    });
    const before = await auditCount('appointment.calendar_viewed');

    await world.api.get(`/appointments/${mine.id}`, world.doctor);
    await world.api.get(`/appointments/${mine.id}/history`, world.doctor);
    await availability(world.doctor.professionalId, world.doctor);
    await world.api.get(`/appointments/${theirs.id}`, world.reception);
    await world.api.get(`/appointments/${theirs.id}/history`, world.admin);
    await availability(world.colleague.professionalId, world.admin);

    expect(await auditCount('appointment.calendar_viewed')).toBe(before);
  });

  it('is not audited when it is not found for the viewer, which looks like a missing appointment', async () => {
    const theirs = await world.book(13, '11:00', {
      professionalId: world.colleague.professionalId,
    });
    const before = await auditCount('appointment.calendar_viewed');

    const refused = await world.api.get(`/appointments/${theirs.id}`, world.doctor);

    expect(refused.statusCode).toBe(404);
    expect(await auditCount('appointment.calendar_viewed')).toBe(before);
  });
});

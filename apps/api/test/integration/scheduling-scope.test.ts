import type { AppointmentDto, AuditAction, Problem } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-scope' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

async function denials() {
  return world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.tenantId, world.tenant.id),
          eq(auditEvent.action, 'access.denied' as AuditAction),
        ),
      )
      .orderBy(desc(auditEvent.occurredAt)),
  );
}

/** A booking request for the professional of the world named, on a Monday of its own. */
async function bookingFor(professionalId: string, weeksAfter: number, time = '10:00') {
  return { ...(await world.bookingBody(weeksAfter, time)), professionalId };
}

describe('a professional works in their own calendar', () => {
  it('books, holds and plans in their own calendar', async () => {
    const own = world.doctor.professionalId;

    const book = await world.api.post('/appointments', world.doctor, await bookingFor(own, 1));
    const hold = await world.api.post('/slot-holds', world.doctor, {
      professionalId: own,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      local: { date: world.monday(1), time: '12:00' },
    });
    const availability = await world.api.get(
      `/availability?professionalId=${own}&typeId=${world.consulta}&from=${world.monday(2)}&to=${world.monday(2)}`,
      world.doctor,
    );

    expect(book.statusCode, book.body).toBe(201);
    expect(hold.statusCode, hold.body).toBe(201);
    expect(availability.statusCode).toBe(200);
  });

  it('is refused, and audited, in a colleague’s calendar: booking, holding, planning a series, looking up free time', async () => {
    const theirs = world.colleague.professionalId;
    const before = (await denials()).length;

    const book = await world.api.post('/appointments', world.doctor, await bookingFor(theirs, 2));
    const hold = await world.api.post('/slot-holds', world.doctor, {
      professionalId: theirs,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      local: { date: world.monday(2), time: '12:00' },
    });
    const series = await world.api.post('/appointments/series', world.doctor, {
      ...(await bookingFor(theirs, 2)),
      recurrence: { frequency: 'weekly', count: 2 },
      mode: 'dry_run',
    });
    const availability = await world.api.get(
      `/availability?professionalId=${theirs}&typeId=${world.consulta}&from=${world.monday(2)}&to=${world.monday(2)}`,
      world.doctor,
    );

    for (const response of [book, hold, series, availability]) {
      expect(response.statusCode).toBe(403);
      expect(response.json<Problem>().code).toBe('forbidden');
    }
    const rows = await denials();
    expect(rows.length).toBe(before + 4);
    expect(rows.slice(0, 4).every((row) => row.reason === 'not_own_calendar')).toBe(true);
  });

  it('is refused for every change to an appointment of a colleague, and for reading its history', async () => {
    const theirs = await world.book(3, '10:00', { professionalId: world.colleague.professionalId });

    const attempts = await Promise.all([
      world.act(theirs, 'confirm', world.doctor, {}),
      world.act(theirs, 'check-in', world.doctor, {}),
      world.act(theirs, 'cancel', world.doctor, {
        cancelledBy: 'patient',
        reasonCode: 'illness',
      }),
      world.act(theirs, 'reschedule', world.doctor, {
        expectedVersion: 1,
        local: { date: world.monday(4), time: '10:00' },
      }),
      world.act(theirs, 'correct', world.doctor, {
        toStatus: 'attended',
        reason: 'x',
      }),
      world.api.get(`/appointments/${theirs.id}/history`, world.doctor),
      world.api.get(`/appointments/${theirs.id}`, world.doctor),
    ]);

    expect(attempts.map((response) => response.statusCode)).toEqual([
      403, 403, 403, 403, 403, 403, 403,
    ]);
    const unchanged = await world.api.get(`/appointments/${theirs.id}`, world.colleague);
    expect(unchanged.json<AppointmentDto>()).toMatchObject({ status: 'scheduled', version: 1 });
  });

  it('cannot move their own appointment into a colleague’s calendar', async () => {
    const own = await world.book(5, '10:00', {}, world.doctor);

    const response = await world.act(own, 'reschedule', world.doctor, {
      expectedVersion: 1,
      professionalId: world.colleague.professionalId,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('a delegated calendar', () => {
  it('opens exactly the calendars named in the grant, and closes at once when it is revoked', async () => {
    await world.delegateCalendar(world.doctor, [world.colleague.professionalId]);
    const delegated = await world.api.post(
      '/appointments',
      world.doctor,
      await bookingFor(world.colleague.professionalId, 6),
    );
    const third = await world.addProfessional();
    const notDelegated = await world.api.post(
      '/appointments',
      world.doctor,
      await bookingFor(third.professionalId, 6),
    );
    await world.revokeDelegation(world.doctor);
    const afterRevoke = await world.api.post(
      '/appointments',
      world.doctor,
      await bookingFor(world.colleague.professionalId, 7),
    );

    expect(delegated.statusCode, delegated.body).toBe(201);
    expect(notDelegated.statusCode).toBe(403);
    expect(afterRevoke.statusCode).toBe(403);
  });

  it('lets the delegate act on the appointments of that calendar', async () => {
    await world.delegateCalendar(world.doctor, [world.colleague.professionalId]);
    try {
      const theirs = await world.book(8, '10:00', {
        professionalId: world.colleague.professionalId,
      });

      const confirm = await world.act(theirs, 'confirm', world.doctor, {});
      const history = await world.api.get(`/appointments/${theirs.id}/history`, world.doctor);

      expect(confirm.statusCode).toBe(200);
      expect(history.statusCode).toBe(200);
    } finally {
      await world.revokeDelegation(world.doctor);
    }
  });
});

describe('owner, admin and reception are not limited to one calendar', () => {
  it('book in any professional’s calendar of their locations', async () => {
    const byAdmin = await world.api.post(
      '/appointments',
      world.admin,
      await bookingFor(world.colleague.professionalId, 9),
    );
    const byReception = await world.api.post(
      '/appointments',
      world.reception,
      await bookingFor(world.doctor.professionalId, 9),
    );

    expect(byAdmin.statusCode).toBe(201);
    expect(byReception.statusCode).toBe(201);
  });
});

describe('reception operates its own locations', () => {
  it('cannot check in, cancel or move an appointment at another location', async () => {
    const norteDoctor = await world.addProfessional();
    await world.api.put(`/professionals/${norteDoctor.professionalId}/hours`, norteDoctor, {
      hours: [{ locationId: world.norte, weekday: 1, start: '09:00', end: '13:00' }],
    });
    const response = await world.api.post('/appointments', world.admin, {
      ...(await world.bookingBody(10, '10:00')),
      professionalId: norteDoctor.professionalId,
      locationId: world.norte,
    });
    const norteAppointment = response.json<AppointmentDto>();

    const attempts = await Promise.all([
      world.act(norteAppointment, 'check-in', world.reception, {}),
      world.act(norteAppointment, 'cancel', world.reception, {
        cancelledBy: 'patient',
        reasonCode: 'illness',
      }),
      world.act(norteAppointment, 'reschedule', world.reception, {
        expectedVersion: 1,
        local: { date: world.monday(11), time: '10:00' },
      }),
    ]);

    expect(attempts.map((r) => r.statusCode)).toEqual([403, 403, 403]);
    expect((await world.act(norteAppointment, 'check-in', world.admin, {})).statusCode).toBe(200);
  });
});

describe('a read-only organization: every scheduling route has a category and honours it', () => {
  const PREFIXES = [
    '/appointment-types',
    '/schedule-blocks',
    '/days-off',
    '/holidays',
    '/appointments',
    '/slot-holds',
    '/availability',
    '/worklist',
    '/professionals/:professionalId/hours-periods',
  ];
  const ID = '0190a000-0000-7000-8000-0000000000aa';

  const schedulingRoutes = () =>
    [...world.app.routeCategories.entries()]
      .filter(([route]) => PREFIXES.some((prefix) => route.split(' ')[1]?.startsWith(prefix)))
      .map(([route, category]) => {
        const [method = 'GET', url = ''] = route.split(' ');
        return { method, url, category, label: route };
      })
      .filter((route) => route.method !== 'HEAD' && route.method !== 'OPTIONS');

  it('lists the scheduling routes and every one has a known category', () => {
    const routes = schedulingRoutes();

    expect(routes.length).toBeGreaterThanOrEqual(35);
    for (const route of routes) {
      expect(['read', 'write', 'patient_protective'], route.label).toContain(route.category);
    }
    // Only the cancellation of an appointment is patient-protective; reads are reads.
    expect(routes.filter((r) => r.category === 'patient_protective').map((r) => r.label)).toEqual([
      'POST /appointments/:id/cancel',
    ]);
    expect(routes.filter((r) => r.method === 'GET').every((r) => r.category === 'read')).toBe(true);
    expect(routes.filter((r) => r.method !== 'GET').every((r) => r.category !== 'read')).toBe(true);
  });

  it('refuses every write with 402 while read-only, and serves reads and the cancellation', async () => {
    const toCancel = await world.book(12, '10:00');
    await world.inTenant((tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, world.tenant.id)),
    );
    try {
      for (const route of schedulingRoutes()) {
        const url = route.url.replaceAll(/:\w+/g, ID);
        const send = (path: string) =>
          route.method === 'GET'
            ? world.api.get(path, world.admin)
            : route.method === 'DELETE'
              ? world.api.delete(path, world.admin)
              : route.method === 'PUT'
                ? world.api.put(path, world.admin, {})
                : route.method === 'PATCH'
                  ? world.api.patch(path, world.admin, {})
                  : world.api.post(path, world.admin, {});
        const response = await send(url);

        if (route.category === 'write') {
          expect(response.statusCode, route.label).toBe(402);
        } else {
          expect(response.statusCode, route.label).not.toBe(402);
        }
      }
      const cancel = await world.act(toCancel, 'cancel', world.reception, {
        cancelledBy: 'patient',
        reasonCode: 'illness',
      });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json<AppointmentDto>().status).toBe('cancelled');
      const book = await world.api.post(
        '/appointments',
        world.reception,
        await world.bookingBody(13, '10:00'),
      );
      expect(book.statusCode).toBe(402);
      expect(book.json<Problem>().code).toBe('tenant_read_only');
    } finally {
      await world.inTenant((tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, world.tenant.id)),
      );
    }
  });
});

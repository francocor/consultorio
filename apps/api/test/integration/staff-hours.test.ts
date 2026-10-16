import type { AuditAction, WeeklyHoursResponse, WeeklyInterval } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { professionalHours } from '../../src/db/schema/staff.js';
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
let centro: string;
let norte: string;
let madrid: string;
let inactive: string;
let foreign: string;
let counter = 60_000;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'staff-hours' });
  other = await createTestTenant(runtime, { slug: 'staff-hours-b' });
  app = buildTestApplication(runtime);
  api = clientFor(app, 'staff-hours');
  owner = await signInAs(
    app,
    'staff-hours',
    await createTestUser(runtime, tenant.id, { roles: ['owner'], password: TEST_PASSWORD }),
  );
  const place = async (name: string, timeZone?: string) =>
    (await api.post('/locations', owner, timeZone ? { name, timeZone } : { name })).json<{
      id: string;
    }>().id;
  centro = await place('Centro');
  norte = await place('Norte');
  madrid = await place('Madrid', 'Europe/Madrid');
  inactive = await place('Cerrada');
  await api.post(`/locations/${inactive}/deactivate`, owner);
  const outsider = await createTestUser(runtime, other.id, {
    roles: ['owner'],
    password: TEST_PASSWORD,
  });
  const otherOwner = await signInAs(app, 'staff-hours-b', outsider);
  foreign = (
    await clientFor(app, 'staff-hours-b').post('/locations', otherOwner, { name: 'Ajena' })
  ).json<{ id: string }>().id;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await runtime.close();
});

/** A professional with a saved profile, and their session. */
async function doctor() {
  const user = await createTestUser(runtime, tenant.id, {
    roles: ['professional'],
    password: TEST_PASSWORD,
  });
  const session = await signInAs(app, 'staff-hours', user);
  counter += 1;
  const profile = await api.put(`/staff/${user.membershipId}/professional-profile`, session, {
    fullName: `Dr. ${String(counter)}`,
    specialties: ['Medicina general'],
    matricula: { jurisdiction: 'AR-B', number: String(counter) },
  });
  return { user, session, professionalId: profile.json<{ id: string }>().id };
}

const hoursUrl = (professionalId: string) => `/professionals/${professionalId}/hours`;
const interval = (
  locationId: string,
  weekday: number,
  start: string,
  end: string,
): WeeklyInterval => ({ locationId, weekday, start, end });

async function auditRows(action: AuditAction, resourceId: string) {
  const rows = await asTenant(runtime, tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.resourceId === resourceId);
}

describe('PUT /professionals/:id/hours', () => {
  it('stores the weekly schedule, with several intervals a day, and reads it back in order', async () => {
    const d = await doctor();
    const hours = [
      interval(centro, 2, '14:00', '18:00'),
      interval(centro, 1, '09:00', '13:00'),
      interval(norte, 1, '14:00', '18:00'),
      interval(centro, 1, '13:00', '14:00'),
    ];

    const saved = await api.put(hoursUrl(d.professionalId), d.session, { hours });
    const read = await api.get(hoursUrl(d.professionalId), d.session);

    expect(saved.statusCode).toBe(200);
    expect(read.json<WeeklyHoursResponse>()).toEqual({
      professionalId: d.professionalId,
      hours: [
        interval(centro, 1, '09:00', '13:00'),
        interval(centro, 1, '13:00', '14:00'),
        interval(norte, 1, '14:00', '18:00'),
        interval(centro, 2, '14:00', '18:00'),
      ],
    });
  });

  it('rejects Monday 09:00-13:00 at one location and Monday 12:00-16:00 at another, and stores nothing', async () => {
    const d = await doctor();
    await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 3, '09:00', '10:00')],
    });

    const response = await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 1, '09:00', '13:00'), interval(norte, 1, '12:00', '16:00')],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'hours.1', i18nKey: 'staff.hours.overlap' },
    ]);
    const kept = await api.get(hoursUrl(d.professionalId), d.session);
    expect(kept.json<WeeklyHoursResponse>().hours).toEqual([interval(centro, 3, '09:00', '10:00')]);
  });

  it('rejects an end before the start with a translated field error', async () => {
    const d = await doctor();

    const response = await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 1, '13:00', '09:00')],
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: unknown[] }>().errors).toEqual([
      { path: 'hours.0.end', i18nKey: 'staff.hours.end_before_start' },
    ]);
  });

  it('compares absolute instants across locations in different time zones', async () => {
    const d = await doctor();
    // 12:00-15:00 Buenos Aires is 15:00-18:00 UTC; the Madrid interval below is 17:00-20:00 local,
    // that is 15:00-18:00 UTC in summer time and 16:00-19:00 UTC in winter time. Either way it
    // clashes with the first, whatever season "now" is.
    const clash = await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 1, '12:00', '15:00'), interval(madrid, 1, '17:00', '20:00')],
    });
    // The same wall-clock hours are different instants.
    const fine = await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 1, '09:00', '12:00'), interval(madrid, 1, '09:00', '12:00')],
    });

    expect(clash.statusCode).toBe(400);
    expect(fine.statusCode).toBe(200);
  });

  it('answers 404 for a location of another organization and 409 for an inactive one', async () => {
    const d = await doctor();

    const outside = await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(foreign, 1, '09:00', '10:00')],
    });
    const closed = await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(inactive, 1, '09:00', '10:00')],
    });

    expect(outside.statusCode).toBe(404);
    expect(closed.statusCode).toBe(409);
  });

  it('ends the old rows instead of deleting them, and audits the edit', async () => {
    const d = await doctor();
    await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 1, '09:00', '13:00')],
    });

    await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 2, '09:00', '13:00')],
    });

    const rows = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(professionalHours)
        .where(eq(professionalHours.professionalId, d.professionalId)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.removedAt === null)).toHaveLength(1);
    const audit = await auditRows('professional.hours_updated', d.professionalId);
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      outcome: 'allow',
      actorUserId: d.user.id,
      metadata: { intervals: 1 },
    });
  });

  it('writes nothing and audits nothing when the schedule did not change', async () => {
    const d = await doctor();
    const hours = [interval(centro, 1, '09:00', '13:00')];
    await api.put(hoursUrl(d.professionalId), d.session, { hours });

    await api.put(hoursUrl(d.professionalId), d.session, { hours });

    expect(await auditRows('professional.hours_updated', d.professionalId)).toHaveLength(1);
    const rows = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .select()
        .from(professionalHours)
        .where(eq(professionalHours.professionalId, d.professionalId)),
    );
    expect(rows).toHaveLength(1);
  });

  it('clears the schedule with an empty list', async () => {
    const d = await doctor();
    await api.put(hoursUrl(d.professionalId), d.session, {
      hours: [interval(centro, 1, '09:00', '13:00')],
    });

    const response = await api.put(hoursUrl(d.professionalId), d.session, { hours: [] });

    expect(response.json<WeeklyHoursResponse>().hours).toEqual([]);
  });
});

describe('who may edit and see hours', () => {
  it('lets an owner edit them, and every staff member read them', async () => {
    const d = await doctor();
    const desk = await signInAs(
      app,
      'staff-hours',
      await createTestUser(runtime, tenant.id, { roles: ['reception'], password: TEST_PASSWORD }),
    );
    const hours = [interval(centro, 4, '08:00', '12:00')];

    expect((await api.put(hoursUrl(d.professionalId), owner, { hours })).statusCode).toBe(200);
    expect(
      (await api.get(hoursUrl(d.professionalId), desk)).json<WeeklyHoursResponse>().hours,
    ).toEqual(hours);
  });

  it('refuses a colleague and reception, with a deny audit row', async () => {
    const d = await doctor();
    const colleague = await doctor();
    const desk = await signInAs(
      app,
      'staff-hours',
      await createTestUser(runtime, tenant.id, { roles: ['reception'], password: TEST_PASSWORD }),
    );
    const hours = [interval(centro, 1, '09:00', '10:00')];

    expect(
      (await api.put(hoursUrl(d.professionalId), colleague.session, { hours })).statusCode,
    ).toBe(403);
    expect((await api.put(hoursUrl(d.professionalId), desk, { hours })).statusCode).toBe(403);
    const rows = await asTenant(runtime, tenant.id, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'access.denied')),
    );
    expect(
      rows.filter((row) => row.resourceId === d.professionalId).map((row) => row.reason),
    ).toEqual(['hours_not_self', 'hours_not_self']);
  });

  it('answers 404 for an unknown professional and one of another organization, and 409 for an inactive one', async () => {
    const d = await doctor();
    const gone = await doctor();
    await api.post(`/staff/${gone.user.membershipId}/deactivate`, owner);
    const hours = [interval(centro, 1, '09:00', '10:00')];

    expect(
      (await api.put(hoursUrl('0190a000-0000-7000-8000-0000000000ee'), owner, { hours }))
        .statusCode,
    ).toBe(404);
    expect((await api.put(hoursUrl(gone.professionalId), owner, { hours })).statusCode).toBe(409);
    const stranger = await createTestUser(runtime, other.id, {
      roles: ['owner'],
      password: TEST_PASSWORD,
    });
    const strangerSession = await signInAs(app, 'staff-hours-b', stranger);
    expect(
      (
        await clientFor(app, 'staff-hours-b').put(hoursUrl(d.professionalId), strangerSession, {
          hours,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects malformed bodies', async () => {
    const d = await doctor();

    for (const body of [
      { hours: [{ ...interval(centro, 1, '09:00', '10:00'), extra: 1 }] },
      { hours: [interval(centro, 9, '09:00', '10:00')] },
      { hours: [interval(centro, 1, '9:00', '10:00')] },
      { rows: [] },
    ]) {
      expect((await api.put(hoursUrl(d.professionalId), d.session, body)).statusCode).toBe(400);
    }
  });
});

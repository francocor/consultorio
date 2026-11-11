import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  appointmentType,
  professionalHoursException,
  scheduleBlock,
  tenantDayOff,
} from '../../src/db/schema/scheduling-config.js';
import { professional } from '../../src/db/schema/staff.js';
import { location } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

let runtime: DbHandle;
let a: TestTenant;
let b: TestTenant;
let placeA: string;
let placeB: string;
let doctorA: string;

const CREATOR = uuidv7();

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  a = await createTestTenant(runtime, { slug: 'sched-config-a' });
  b = await createTestTenant(runtime, { slug: 'sched-config-b' });
  const place = async (tenant: TestTenant) => {
    const [row] = await asTenant(runtime, tenant.id, (tx) =>
      tx
        .insert(location)
        .values({
          tenantId: tenant.id,
          name: 'Centro',
          timeZone: 'America/Argentina/Buenos_Aires',
        })
        .returning({ id: location.id }),
    );
    return row?.id ?? '';
  };
  placeA = await place(a);
  placeB = await place(b);
  const user = await createTestUser(runtime, a.id, { roles: ['professional'] });
  const [doctor] = await asTenant(runtime, a.id, (tx) =>
    tx
      .insert(professional)
      .values({ tenantId: a.id, membershipId: user.membershipId, specialties: ['general'] })
      .returning({ id: professional.id }),
  );
  doctorA = doctor?.id ?? '';
});

afterAll(async () => {
  await runtime.close();
});

const dbError = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

describe('appointment_type', () => {
  const insert = (values: Partial<typeof appointmentType.$inferInsert> = {}) =>
    asTenant(runtime, a.id, (tx) =>
      tx
        .insert(appointmentType)
        .values({ tenantId: a.id, name: 'Consulta', durationMinutes: 30, ...values })
        .returning(),
    );

  it('stores a type with the defaults of an ordinary visit', async () => {
    const [row] = await insert();

    expect(row).toMatchObject({
      bufferMinutes: 0,
      mode: 'in_person',
      requiresApproval: false,
      active: true,
      professionalIds: [],
      specialties: [],
    });
  });

  it.each([0, -5, 1441])('refuses a duration of %i minutes', async (durationMinutes) => {
    expect(await dbError(insert({ durationMinutes }))).toBe('23514');
  });

  it('refuses a negative buffer, an unknown mode and a colour that is not hex', async () => {
    expect(await dbError(insert({ bufferMinutes: -1 }))).toBe('23514');
    expect(await dbError(insert({ mode: 'phone' }))).toBe('23514');
    expect(await dbError(insert({ color: 'red' }))).toBe('23514');
    expect(await insert({ color: '#2563EB' })).toHaveLength(1);
  });
});

describe('schedule_block', () => {
  const insert = (values: Partial<typeof scheduleBlock.$inferInsert> = {}, tenant = a) =>
    asTenant(runtime, tenant.id, (tx) =>
      tx
        .insert(scheduleBlock)
        .values({
          tenantId: tenant.id,
          professionalId: doctorA,
          startsAt: new Date('2026-12-20T00:00:00Z'),
          endsAt: new Date('2026-12-31T00:00:00Z'),
          reason: 'Vacation',
          createdBy: CREATOR,
          ...values,
        })
        .returning(),
    );

  it('blocks a professional, a whole location, or a professional at one location', async () => {
    expect(await insert()).toHaveLength(1);
    expect(await insert({ professionalId: null, locationId: placeA })).toHaveLength(1);
    expect(await insert({ locationId: placeA })).toHaveLength(1);
  });

  it('refuses a block that names neither a professional nor a location', async () => {
    expect(await dbError(insert({ professionalId: null, locationId: null }))).toBe('23514');
  });

  it('refuses an interval that ends before it starts, or is empty', async () => {
    const at = new Date('2026-12-20T10:00:00Z');
    expect(await dbError(insert({ startsAt: at, endsAt: at }))).toBe('23514');
    expect(await dbError(insert({ startsAt: at, endsAt: new Date('2026-12-20T09:00:00Z') }))).toBe(
      '23514',
    );
  });

  it('cannot point at a professional or a location of another organization', async () => {
    expect(await dbError(insert({ professionalId: null, locationId: placeB }))).toBe('23503');
    expect(await dbError(insert({}, b))).toBe('23503');
  });
});

describe('tenant_day_off', () => {
  const insert = (values: Partial<typeof tenantDayOff.$inferInsert> = {}) =>
    asTenant(runtime, a.id, (tx) =>
      tx
        .insert(tenantDayOff)
        .values({
          tenantId: a.id,
          day: '2026-09-17',
          name: 'Patron saint',
          createdBy: CREATOR,
          ...values,
        })
        .returning(),
    );

  it('allows one live day off per day and place, whole organization or one location', async () => {
    expect(await insert()).toHaveLength(1);
    expect(await dbError(insert({ name: 'Again' }))).toBe('23505');
    expect(await insert({ locationId: placeA })).toHaveLength(1);
    expect(await dbError(insert({ locationId: placeA, name: 'Again' }))).toBe('23505');
  });

  it('lets a removed day off be added again', async () => {
    const [first] = await insert({ day: '2026-10-05' });
    await asTenant(runtime, a.id, (tx) =>
      tx
        .update(tenantDayOff)
        .set({ removedAt: new Date() })
        .where(eq(tenantDayOff.id, first?.id ?? '')),
    );

    expect(await insert({ day: '2026-10-05' })).toHaveLength(1);
  });
});

describe('professional_hours_exception', () => {
  const insert = (values: Partial<typeof professionalHoursException.$inferInsert> = {}) =>
    asTenant(runtime, a.id, (tx) =>
      tx
        .insert(professionalHoursException)
        .values({
          tenantId: a.id,
          professionalId: doctorA,
          periodId: uuidv7(),
          dateFrom: '2026-12-01',
          dateTo: '2026-12-15',
          createdBy: CREATOR,
          locationId: placeA,
          weekday: 1,
          startMinute: 540,
          endMinute: 780,
          ...values,
        })
        .returning(),
    );

  it('stores an interval of the period, or a marker row that means "not working"', async () => {
    expect(await insert()).toHaveLength(1);
    expect(
      await insert({ locationId: null, weekday: null, startMinute: null, endMinute: null }),
    ).toHaveLength(1);
  });

  it('refuses a half-filled interval and an inverted one', async () => {
    expect(await dbError(insert({ weekday: null }))).toBe('23514');
    expect(await dbError(insert({ startMinute: 780, endMinute: 540 }))).toBe('23514');
    expect(await dbError(insert({ locationId: null }))).toBe('23514');
  });

  it('refuses a range that ends before it starts', async () => {
    expect(await dbError(insert({ dateFrom: '2026-12-15', dateTo: '2026-12-01' }))).toBe('23514');
  });
});

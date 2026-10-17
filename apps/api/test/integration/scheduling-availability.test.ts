import type {
  AppointmentDto,
  AvailabilityResponse,
  Problem,
  SeriesCommitResponse,
  SeriesConflictExtension,
  SeriesPreviewResponse,
} from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { appointment } from '../../src/db/schema/scheduling.js';
import { seedArHolidays } from '../../src/db/seed/ar-holidays.js';
import { createOwnerDb, createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;
const START = new Date('2031-05-05T12:00:00.000Z');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  const catalog = createOwnerDb(inject('ownerUrl'));
  // Carnaval 2029 falls on Monday 12 February: a national holiday on a day the doctor works.
  await seedArHolidays(catalog.db, [2029]);
  await catalog.close();
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-availability' });
  world.setNow(START);
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const query = (extra: Record<string, string> = {}) =>
  new URLSearchParams({
    professionalId: world.doctor.professionalId,
    typeId: world.consulta,
    ...extra,
  }).toString();

const ask = async (params: Record<string, string>, who = world.reception) => {
  const response = await world.api.get(`/availability?${query(params)}`, who);
  return response;
};
const slotsOf = (response: { json: () => unknown }) =>
  (response.json() as AvailabilityResponse).slots.map((slot) => slot.startsAt.slice(11, 16));

describe('GET /availability', () => {
  it('offers the free times of a working day in the zone of the location, with their local date', async () => {
    const response = await ask({ from: world.monday(1), to: world.monday(1) });

    expect(response.statusCode).toBe(200);
    const body = response.json<AvailabilityResponse>();
    // 09:00-13:00 at Centro in Buenos Aires (UTC-3), 30 minute visits on a 15 minute grid.
    expect(body.slots).toHaveLength(15);
    expect(body.slots[0]).toEqual({
      startsAt: `${world.monday(1)}T12:00:00.000Z`,
      endsAt: `${world.monday(1)}T12:30:00.000Z`,
      locationId: world.centro,
      date: world.monday(1),
    });
    expect(body.slots.at(-1)?.startsAt).toBe(`${world.monday(1)}T15:30:00.000Z`);
    expect(body.closedDays).toEqual([]);
  });

  it('takes out what is booked, including the buffer of the type', async () => {
    await world.book(2, '10:00');
    const plain = await ask({ from: world.monday(2), to: world.monday(2) });
    const buffered = await ask({
      from: world.monday(2),
      to: world.monday(2),
      typeId: world.withBuffer,
    });

    expect(slotsOf(plain)).not.toContain('13:00');
    expect(slotsOf(plain)).not.toContain('12:45'); // a 30 minute visit from 09:45 would overlap
    expect(slotsOf(plain)).toContain('12:30');
    expect(slotsOf(plain)).toContain('13:30');
    // With a 10 minute buffer the visit needs 40 minutes before the booked one.
    expect(slotsOf(buffered)).not.toContain('12:30');
    expect(slotsOf(buffered)).toContain('12:15');
  });

  it('offers nothing inside a block', async () => {
    const day = world.monday(3);
    await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: `${day}T00:00:00-03:00`,
      endsAt: `${day}T23:59:00-03:00`,
      reason: 'Vacation',
    });

    const response = await ask({ from: day, to: day });

    expect(response.json<AvailabilityResponse>().slots).toEqual([]);
  });

  it('marks a national holiday and a day off of the organization, and offers no slot on them', async () => {
    const dayOffMonday = world.monday(8);
    await world.api.post('/days-off', world.owner, { day: dayOffMonday, name: 'Closure' });
    world.setNow(new Date('2029-01-05T12:00:00.000Z'));

    const national = await ask({ from: '2029-02-12', to: '2029-02-12' });
    world.setNow(START);
    const dayOff = await ask({ from: dayOffMonday, to: dayOffMonday });

    expect(national.json<AvailabilityResponse>().slots).toEqual([]);
    expect(national.json<AvailabilityResponse>().closedDays).toEqual([
      expect.objectContaining({ date: '2029-02-12', name: 'Carnaval', source: 'national' }),
    ]);
    expect(dayOff.json<AvailabilityResponse>().slots).toEqual([]);
    expect(dayOff.json<AvailabilityResponse>().closedDays).toEqual([
      expect.objectContaining({ date: dayOffMonday, name: 'Closure', source: 'organization' }),
    ]);
  });

  it('never offers the past, and nothing for a professional who does not work that day', async () => {
    world.setNow(new Date(`${world.monday(4)}T14:10:00.000Z`));
    const today = await ask({ from: world.monday(4), to: world.monday(4) });
    world.setNow(START);
    const tuesday = new Date(Date.parse(`${world.monday(4)}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const noHours = await ask({ from: tuesday, to: tuesday });

    expect(slotsOf(today)[0]).toBe('14:15');
    expect(noHours.json<AvailabilityResponse>().slots).toEqual([]);
  });

  it('shows the hours of a range of dates in place of the weekly hours', async () => {
    const day = world.monday(5);
    await world.api.post(
      `/professionals/${world.colleague.professionalId}/hours-periods`,
      world.colleague,
      {
        dateFrom: day,
        dateTo: day,
        hours: [{ locationId: world.centro, weekday: 1, start: '10:00', end: '11:00' }],
      },
    );

    const response = await ask({
      from: day,
      to: day,
      professionalId: world.colleague.professionalId,
    });

    expect(slotsOf(response)).toEqual(['13:00', '13:15', '13:30']);
  });

  it('shows reception only the locations it works at', async () => {
    const day = world.monday(6);
    await world.api.put(`/professionals/${world.colleague.professionalId}/hours`, world.colleague, {
      hours: [
        { locationId: world.centro, weekday: 1, start: '09:00', end: '10:00' },
        { locationId: world.norte, weekday: 1, start: '14:00', end: '15:00' },
      ],
    });

    const asReception = await ask({
      from: day,
      to: day,
      professionalId: world.colleague.professionalId,
    });
    const asAdmin = await ask(
      { from: day, to: day, professionalId: world.colleague.professionalId },
      world.admin,
    );
    const norteOnly = await ask(
      {
        from: day,
        to: day,
        professionalId: world.colleague.professionalId,
        locationId: world.norte,
      },
      world.reception,
    );

    expect(
      new Set(asReception.json<AvailabilityResponse>().slots.map((s) => s.locationId)),
    ).toEqual(new Set([world.centro]));
    expect(new Set(asAdmin.json<AvailabilityResponse>().slots.map((s) => s.locationId))).toEqual(
      new Set([world.centro, world.norte]),
    );
    expect(norteOnly.json<AvailabilityResponse>().slots).toEqual([]);
  });

  it('validates the query and the references', async () => {
    expect((await ask({ from: world.monday(1), to: world.monday(20) })).statusCode).toBe(400);
    expect((await ask({ from: world.monday(2), to: world.monday(1) })).statusCode).toBe(400);
    expect(
      (
        await ask({
          from: world.monday(1),
          to: world.monday(1),
          typeId: '0190a000-0000-7000-8000-0000000000aa',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await world.api.get(
          `/availability?${query({ from: world.monday(1), to: world.monday(1) })}`,
          null,
        )
      ).statusCode,
    ).toBe(401);
  });

  it('works in a read-only organization (it is a read)', async () => {
    await world.inTenant((tx) =>
      tx.execute(sql`UPDATE tenant SET status = 'read_only', read_only_since = now()`),
    );
    try {
      expect((await ask({ from: world.monday(1), to: world.monday(1) })).statusCode).toBe(200);
    } finally {
      await world.inTenant((tx) =>
        tx.execute(sql`UPDATE tenant SET status = 'active', read_only_since = NULL`),
      );
    }
  });
});

describe('POST /appointments/series', () => {
  const send = async (
    weeksAfter: number,
    extra: Record<string, unknown>,
    who = world.reception,
  ) => {
    const first = await world.bookingBody(weeksAfter, '10:00');
    return world.api.post('/appointments/series', who, {
      ...first,
      recurrence: { frequency: 'weekly', count: 6 },
      mode: 'dry_run',
      ...extra,
    });
  };

  it('previews a weekly series without creating anything', async () => {
    const response = await send(10, {});

    expect(response.statusCode).toBe(200);
    const preview = response.json<SeriesPreviewResponse>();
    expect(preview.canCommit).toBe(true);
    expect(preview.occurrences.map((o) => o.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    expect(preview.occurrences[1]?.startsAt).toBe(`${world.monday(11)}T13:00:00.000Z`);
    const count = await world.inTenant((tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM appointment WHERE starts_at = ${`${world.monday(11)}T13:00:00Z`}::timestamptz`,
      ),
    );
    expect(count.rows[0]?.n).toBe(0);
  });

  it('reports the session that falls on a block, creates nothing until it is skipped, then creates the rest', async () => {
    const blocked = world.monday(23); // the 4th session of a series starting 20 weeks after
    await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: `${blocked}T00:00:00-03:00`,
      endsAt: `${blocked}T23:59:00-03:00`,
      reason: 'Course',
    });

    const preview = await send(20, {});
    const refused = await send(20, { mode: 'commit' });
    const committed = await send(20, { mode: 'commit', skip: [4] });

    expect(
      preview.json<SeriesPreviewResponse>().occurrences.filter((o) => o.status === 'conflict'),
    ).toEqual([expect.objectContaining({ index: 4, reason: 'blocked' })]);
    expect(preview.json<SeriesPreviewResponse>().canCommit).toBe(false);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<Problem & SeriesConflictExtension>().occurrences[3]).toMatchObject({
      index: 4,
      status: 'conflict',
    });
    expect(committed.statusCode, committed.body).toBe(201);
    const result = committed.json<SeriesCommitResponse>();
    expect(result.appointments).toHaveLength(5);
    expect(result.skipped).toEqual([4]);
    expect(new Set(result.appointments.map((a) => a.seriesId))).toEqual(new Set([result.seriesId]));
    expect(result.appointments.map((a) => a.seriesIndex)).toEqual([1, 2, 3, 5, 6]);
  });

  it('creates nothing when it is refused (the first attempt left no session behind)', async () => {
    const blocked = world.monday(33);
    await world.api.post('/schedule-blocks', world.owner, {
      professionalId: world.doctor.professionalId,
      startsAt: `${blocked}T00:00:00-03:00`,
      endsAt: `${blocked}T23:59:00-03:00`,
      reason: 'Course',
    });

    const refused = await send(30, { mode: 'commit' });

    expect(refused.statusCode).toBe(409);
    const rows = await world.inTenant((tx) =>
      tx
        .select({ id: appointment.id })
        .from(appointment)
        .where(eq(appointment.startsAt, new Date(`${world.monday(30)}T13:00:00Z`))),
    );
    expect(rows).toEqual([]);
  });

  it('keeps each session independent: cancelling session 3 touches only that one', async () => {
    const response = await send(40, { mode: 'commit' });
    const { appointments } = response.json<SeriesCommitResponse>();
    const third = appointments[2] as AppointmentDto;

    const cancel = await world.api.post(`/appointments/${third.id}/cancel`, world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });
    const others = await world.inTenant((tx) =>
      tx
        .select({ status: appointment.status })
        .from(appointment)
        .where(eq(appointment.seriesId, third.seriesId ?? '')),
    );

    expect(cancel.json<AppointmentDto>().status).toBe('cancelled');
    expect(others.map((row) => row.status).sort()).toEqual([
      'cancelled',
      'scheduled',
      'scheduled',
      'scheduled',
      'scheduled',
      'scheduled',
    ]);
    // And a session can be moved on its own.
    const moved = await world.api.post(
      `/appointments/${appointments[0]?.id ?? ''}/reschedule`,
      world.reception,
      {
        expectedVersion: 1,
        local: { date: world.monday(47), time: '11:00' },
      },
    );
    expect(moved.statusCode).toBe(200);
  });

  it('shows a taken session as a conflict, and ignores an override nothing needed', async () => {
    await world.book(52, '10:00', {}, world.admin);

    const preview = await send(51, {});
    const unneeded = await send(60, { mode: 'commit', overrideHours: { reason: 'Rehab' } });

    expect(preview.json<SeriesPreviewResponse>().occurrences[1]).toMatchObject({
      index: 2,
      status: 'conflict',
      reason: 'slot_taken',
    });
    // Nothing needed the override, so it is simply not used; the series is created.
    expect(unneeded.statusCode).toBe(201);
  });
});

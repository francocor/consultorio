import type {
  AppointmentDto,
  HoldDto,
  Problem,
  SlotConflictExtension,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { appointment, slotHold } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * Concurrency through the whole stack (route, use case, row lock, database), not straight on the
 * tables: the lock of the professional serializes the writers, the exclusion constraint is the net
 * under it, and the loser always gets the same 409 `slot_taken` with the next free times.
 */

let runtime: DbHandle;
let world: SchedulingHttpWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-races' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** Monday 09:00-13:00 local (UTC-3), so 13:00Z is 10:00 local. */
const utcOf = (weeksAfter: number, hhmm: string) =>
  new Date(`${world.monday(weeksAfter)}T${hhmm}:00Z`);

async function seed(input: {
  professionalId: string;
  weeksAfter: number;
  from: string;
  to: string;
  lane: number;
}) {
  const patientId = await world.freshPatient();
  const startsAt = utcOf(input.weeksAfter, input.from);
  const endsAt = utcOf(input.weeksAfter, input.to);
  const [row] = await world.inTenant((tx) =>
    tx
      .insert(appointment)
      .values({
        tenantId: world.tenant.id,
        patientId,
        professionalId: input.professionalId,
        locationId: world.centro,
        appointmentTypeId: world.consulta,
        startsAt,
        endsAt,
        bufferMinutes: 0,
        lane: input.lane,
        status: 'scheduled',
        identityConfirmed: true,
        bookedBy: world.reception.user.id,
      })
      .returning(),
  );
  if (!row) throw new Error('appointment insert returned no row');
  return row;
}

const book = async (professionalId: string, weeksAfter: number, time: string) =>
  world.api.post('/appointments', world.reception, {
    ...(await world.bookingBody(weeksAfter, time)),
    professionalId,
  });

/** The one response that lost the race. */
function loser(results: LightMyRequestResponse[]): LightMyRequestResponse {
  const found = results.find((response) => response.statusCode === 409);
  if (!found) throw new Error('nobody lost the race');
  return found;
}

function expectSlotTaken(response: LightMyRequestResponse) {
  expect(response.statusCode).toBe(409);
  const problem = response.json<Problem & Partial<SlotConflictExtension>>();
  expect(problem.code).toBe('slot_taken');
  expect(typeof problem.conflict?.startsAt).toBe('string');
  expect(Array.isArray(problem.nextSlots)).toBe(true);
}

describe('an overbooking professional', () => {
  it('re-lanes a chain of occupancies that only touch the new range (depth 2)', async () => {
    const busy = await world.addProfessional({ maxSimultaneous: 2 });
    // Lane 1: B 10:00-10:40 and E 11:15-12:00. Lane 2: C 10:40-11:30. The booking at 10:30-11:00
    // touches B and C; E is connected to it through C only.
    const b = await seed({
      professionalId: busy.professionalId,
      weeksAfter: 26,
      from: '13:00',
      to: '13:40',
      lane: 1,
    });
    const c = await seed({
      professionalId: busy.professionalId,
      weeksAfter: 26,
      from: '13:40',
      to: '14:30',
      lane: 2,
    });
    const e = await seed({
      professionalId: busy.professionalId,
      weeksAfter: 26,
      from: '14:15',
      to: '15:00',
      lane: 1,
    });

    const created = await book(busy.professionalId, 26, '10:30');

    expect(created.statusCode, created.body).toBe(201);
    const lanes = await world.inTenant(async (tx) => {
      const rows = await tx
        .select({ id: appointment.id, lane: appointment.lane })
        .from(appointment)
        .where(eq(appointment.professionalId, busy.professionalId));
      return new Map(rows.map((row) => [row.id, row.lane]));
    });
    expect(lanes.get(b.id)).toBe(1);
    expect(lanes.get(c.id)).toBe(1);
    expect(lanes.get(e.id)).toBe(2);
    expect(lanes.get(created.json<AppointmentDto>().id)).toBe(2);
  });

  it('lets exactly two of three simultaneous requests win, and gives the third the full conflict', async () => {
    const busy = await world.addProfessional({ maxSimultaneous: 2 });

    const results = await Promise.all([
      book(busy.professionalId, 27, '10:00'),
      book(busy.professionalId, 27, '10:00'),
      book(busy.professionalId, 27, '10:00'),
    ]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201, 409]);
    const lanes = await world.inTenant((tx) =>
      tx
        .select({ lane: appointment.lane })
        .from(appointment)
        .where(eq(appointment.professionalId, busy.professionalId)),
    );
    expect(lanes.map((row) => row.lane).sort()).toEqual([1, 2]);
    expectSlotTaken(loser(results));
  });
});

describe('a hold and a booking for the same range', () => {
  it('lets exactly one win, and the loser gets the conflict with the next free times', async () => {
    const solo = await world.addProfessional();
    const holdRequest = {
      professionalId: solo.professionalId,
      locationId: world.centro,
      appointmentTypeId: world.consulta,
      local: { date: world.monday(29), time: '10:00' },
    };

    const [hold, booking] = await Promise.all([
      world.api.post('/slot-holds', world.reception, holdRequest),
      book(solo.professionalId, 29, '10:00'),
    ]);

    expect([hold.statusCode, booking.statusCode].sort()).toEqual([201, 409]);
    expectSlotTaken(hold.statusCode === 409 ? hold : booking);
    // Whoever won, the range has exactly one occupant.
    const holds = await world.inTenant((tx) =>
      tx.select().from(slotHold).where(eq(slotHold.professionalId, solo.professionalId)),
    );
    const appointments = await world.inTenant((tx) =>
      tx.select().from(appointment).where(eq(appointment.professionalId, solo.professionalId)),
    );
    expect(holds.filter((row) => row.status === 'active').length + appointments.length).toBe(1);
    if (hold.statusCode === 201) expect(hold.json<HoldDto>().status).toBe('active');
  });
});

describe('two moves to the same range', () => {
  it('lets exactly one reschedule win, and the loser gets the conflict with the next free times', async () => {
    const solo = await world.addProfessional();
    const first = await seed({
      professionalId: solo.professionalId,
      weeksAfter: 31,
      from: '12:00',
      to: '12:30',
      lane: 1,
    });
    const second = await seed({
      professionalId: solo.professionalId,
      weeksAfter: 31,
      from: '12:30',
      to: '13:00',
      lane: 1,
    });
    const move = (id: string) =>
      world.api.post(`/appointments/${id}/reschedule`, world.reception, {
        expectedVersion: 1,
        local: { date: world.monday(31), time: '11:00' },
      });

    const results = await Promise.all([move(first.id), move(second.id)]);

    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expectSlotTaken(loser(results));
    const stored = await world.inTenant((tx) =>
      tx.select().from(appointment).where(eq(appointment.professionalId, solo.professionalId)),
    );
    expect(
      stored.filter((row) => row.startsAt.getTime() === utcOf(31, '14:00').getTime()),
    ).toHaveLength(1);
  });
});

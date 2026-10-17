import type { AppointmentDto, HoldDto, Problem } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { appointment, slotHold } from '../../src/db/schema/scheduling.js';
import { createSchedulingPorts } from '../../src/modules/scheduling/application/drizzle-ports.js';
import {
  HOLD_EXPIRE_JOB,
  holdExpireJob,
} from '../../src/modules/scheduling/application/hold-expiry.js';
import { createHold } from '../../src/modules/scheduling/application/holds.js';
import { SlotTakenError } from '../../src/modules/scheduling/application/placement.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { runJob } from '../../src/platform/jobs/define-job.js';
import { startWorker } from '../../src/platform/jobs/worker.js';
import { eventually } from '../support/eventually.js';
import {
  createSchedulingHttpWorld,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { occupancyOf } from '../support/scheduling.js';

let runtime: DbHandle;
let world: SchedulingHttpWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-holds' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const START = new Date('2031-05-05T12:00:00.000Z');
const holdBody = (
  weeksAfter: number,
  time = '10:00',
  professionalId = world.doctor.professionalId,
) => ({
  professionalId,
  locationId: world.centro,
  appointmentTypeId: world.consulta,
  local: { date: world.monday(weeksAfter), time },
});

async function newHold(weeksAfter: number, time = '10:00', by = world.reception) {
  const response = await world.api.post('/slot-holds', by, holdBody(weeksAfter, time));
  expect(response.statusCode, response.body).toBe(201);
  return response.json<HoldDto>();
}

async function holdRow(id: string) {
  const [row] = await world.inTenant((tx) => tx.select().from(slotHold).where(eq(slotHold.id, id)));
  return row;
}

describe('creating a hold', () => {
  it('reserves the range for ten minutes with no patient and no appointment status', async () => {
    world.setNow(START);

    const created = await newHold(1);

    expect(created).toMatchObject({
      status: 'active',
      origin: 'staff',
      startsAt: `${world.monday(1)}T13:00:00.000Z`,
      endsAt: `${world.monday(1)}T13:30:00.000Z`,
      expiresAt: new Date(START.getTime() + 10 * 60_000).toISOString(),
    });
    expect(Object.keys(created)).not.toContain('patientId');
    expect(await holdRow(created.id)).toMatchObject({
      sourceKey: world.reception.user.id,
      lane: 1,
    });
  });

  it('keeps others from booking the range while it is active, exactly as an appointment would', async () => {
    world.setNow(START);
    await newHold(2);

    const clash = await world.api.post(
      '/appointments',
      world.admin,
      await world.bookingBody(2, '10:00'),
    );
    const touching = await world.api.post(
      '/appointments',
      world.admin,
      await world.bookingBody(2, '10:30'),
    );

    expect(clash.statusCode).toBe(409);
    expect(clash.json<Problem>().code).toBe('slot_taken');
    expect(touching.statusCode).toBe(201);
  });

  it('frees the range when the hold runs out: booking an expired hold range succeeds', async () => {
    world.setNow(START);
    const created = await newHold(3);

    world.setNow(new Date(START.getTime() + 11 * 60_000));
    const booked = await world.api.post(
      '/appointments',
      world.admin,
      await world.bookingBody(3, '10:00'),
    );
    world.setNow(START);

    expect(booked.statusCode).toBe(201);
    expect((await holdRow(created.id))?.status).toBe('expired');
  });

  it('is bounded per source: a new hold releases the previous one of the same person', async () => {
    world.setNow(START);
    const first = await newHold(4, '10:00');
    const second = await newHold(4, '11:00');
    const byAdmin = await newHold(4, '12:00', world.admin);

    expect((await holdRow(first.id))?.status).toBe('released');
    expect((await holdRow(second.id))?.status).toBe('active');
    expect((await holdRow(byAdmin.id))?.status).toBe('active');
    // The released range is free at once.
    expect(
      (await world.api.post('/appointments', world.admin, await world.bookingBody(4, '10:00')))
        .statusCode,
    ).toBe(201);
  });

  it('applies the hours rule and the location scope of a booking', async () => {
    world.setNow(START);

    const early = await world.api.post('/slot-holds', world.reception, holdBody(5, '15:00'));
    const elsewhere = await world.api.post('/slot-holds', world.reception, {
      ...holdBody(5),
      locationId: world.norte,
    });

    expect(early.statusCode).toBe(400);
    expect(early.json<Problem>().errors?.[0]?.i18nKey).toBe(
      'scheduling.booking.outside_working_hours',
    );
    expect(elsewhere.statusCode).toBe(403);
  });

  it('leaves no trace in the history or the audit trail (it is not an appointment)', async () => {
    world.setNow(START);
    const before = await world.inTenant((tx) => tx.select().from(auditEvent));

    await newHold(6);

    const after = await world.inTenant((tx) => tx.select().from(auditEvent));
    expect(after.length).toBe(before.length);
  });
});

describe('releasing a hold', () => {
  it('lets the holder give the range back, and nobody else', async () => {
    world.setNow(START);
    const created = await newHold(7);

    const foreign = await world.api.delete(`/slot-holds/${created.id}`, world.admin);
    const released = await world.api.delete(`/slot-holds/${created.id}`, world.reception);
    const again = await world.api.delete(`/slot-holds/${created.id}`, world.reception);

    expect(foreign.statusCode).toBe(404);
    expect(released.json<HoldDto>().status).toBe('released');
    expect(again.statusCode).toBe(409);
    expect(
      (await world.api.post('/appointments', world.admin, await world.bookingBody(7, '10:00')))
        .statusCode,
    ).toBe(201);
  });
});

describe('converting a hold into an appointment', () => {
  it('re-runs the validations, ends the hold as converted and links it to the appointment', async () => {
    world.setNow(START);
    const created = await newHold(8);

    const response = await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(8, '10:00')),
      holdId: created.id,
    });

    expect(response.statusCode, response.body).toBe(201);
    const booked = response.json<AppointmentDto>();
    expect(await holdRow(created.id)).toMatchObject({
      status: 'converted',
      appointmentId: booked.id,
    });
    const rows = await world.inTenant((tx) => occupancyOf(tx, world.doctor.professionalId));
    expect(rows.find((row) => row.slot_hold_id === created.id)?.active).toBe(false);
    expect(rows.find((row) => row.appointment_id === booked.id)?.active).toBe(true);
    const stored = await world.inTenant((tx) =>
      tx.select().from(appointment).where(eq(appointment.id, booked.id)),
    );
    expect(stored[0]?.lane).toBe(1);
  });

  it('is a validation error when the hold is for another range, and not found for someone else hold', async () => {
    world.setNow(START);
    const created = await newHold(9, '10:00');

    const other = await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(9, '11:00')),
      holdId: created.id,
    });
    const stranger = await world.api.post('/appointments', world.admin, {
      ...(await world.bookingBody(9, '10:00')),
      holdId: created.id,
    });

    expect(other.statusCode).toBe(400);
    expect(other.json<Problem>().errors?.[0]?.i18nKey).toBe('scheduling.hold.mismatch');
    expect(stranger.statusCode).toBe(404);
    expect((await holdRow(created.id))?.status).toBe('active');
  });

  it('answers 409 slot_no_longer_available after the hold ran out, was released or was converted', async () => {
    world.setNow(START);
    const ranOut = await newHold(10, '10:00');
    world.setNow(new Date(START.getTime() + 11 * 60_000));
    const late = await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(10, '10:00')),
      holdId: ranOut.id,
    });
    world.setNow(START);

    const released = await newHold(11, '10:00');
    await world.api.delete(`/slot-holds/${released.id}`, world.reception);
    const afterRelease = await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(11, '10:00')),
      holdId: released.id,
    });

    const used = await newHold(12, '10:00');
    await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(12, '10:00')),
      holdId: used.id,
    });
    const twice = await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(12, '10:00')),
      holdId: used.id,
    });

    for (const response of [late, afterRelease, twice]) {
      expect(response.statusCode).toBe(409);
      expect(response.json<Problem>()).toMatchObject({
        code: 'slot_no_longer_available',
        i18nKey: 'errors.slot_no_longer_available',
      });
    }
  });
});

describe('a staff override of a hold', () => {
  it('books over the hold with the explicit override, invalidates it, audits it, and tells the holder', async () => {
    world.setNow(START);
    const held = await newHold(13);

    const without = await world.api.post(
      '/appointments',
      world.admin,
      await world.bookingBody(13, '10:00'),
    );
    const forced = await world.api.post('/appointments', world.admin, {
      ...(await world.bookingBody(13, '10:00')),
      overrideHold: true,
    });
    const holder = await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(13, '10:00')),
      holdId: held.id,
    });

    expect(without.statusCode).toBe(409);
    expect(forced.statusCode, forced.body).toBe(201);
    expect((await holdRow(held.id))?.status).toBe('invalidated');
    expect(holder.statusCode).toBe(409);
    expect(holder.json<Problem>().code).toBe('slot_no_longer_available');
    const audits = await world.inTenant((tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'appointment.overridden')),
    );
    expect(audits.some((row) => JSON.stringify(row.metadata).includes('hold'))).toBe(true);
  });

  it('refuses the override to reception until it is granted, and takes effect when it is', async () => {
    world.setNow(START);
    const held = await newHold(18);
    const request = { ...(await world.bookingBody(18, '10:00')), overrideHold: true };

    const denied = await world.api.post('/appointments', world.reception, request);
    const stillHeld = (await holdRow(held.id))?.status;
    await world.grantPermission(world.reception, 'scheduling.override_hold');
    try {
      const allowed = await world.api.post('/appointments', world.reception, {
        ...request,
        patientId: await world.freshPatient(),
      });

      expect(allowed.statusCode, allowed.body).toBe(201);
    } finally {
      await world.revokePermission(world.reception, 'scheduling.override_hold');
    }

    expect(denied.statusCode).toBe(403);
    expect(denied.json<Problem>().code).toBe('forbidden');
    // The refusal left the hold exactly as it was.
    expect(stillHeld).toBe('active');
    expect((await holdRow(held.id))?.status).toBe('invalidated');
  });
});

describe('public holds (capacity 1)', () => {
  it('refuses a range that any appointment overlaps, however much capacity the professional has', async () => {
    const busy = await world.addProfessional({ maxSimultaneous: 2 });
    world.setNow(START);
    const first = await world.api.post('/appointments', world.reception, {
      ...(await world.bookingBody(14, '10:00')),
      professionalId: busy.professionalId,
    });
    expect(first.statusCode).toBe(201);
    const attempt = (origin: 'public' | 'staff') =>
      world.inTenant((tx) =>
        createHold(createSchedulingPorts(tx, { keys: world.keys }), {
          request: {
            professionalId: busy.professionalId,
            locationId: world.centro,
            appointmentTypeId: world.consulta,
            local: { date: world.monday(14), time: '10:00' },
          },
          actor: { userId: world.reception.user.id, permissions: new Set(), professionalId: null },
          now: START,
          origin,
          sourceKey: origin === 'public' ? 'anonymous-session' : world.reception.user.id,
        }),
      );

    const staff = await attempt('staff');
    const publicHold = await attempt('public').catch((error: unknown) => error);

    expect(staff.origin).toBe('staff');
    expect((await holdRow(staff.id))?.lane).toBe(2);
    expect(publicHold).toBeInstanceOf(SlotTakenError);
  });

  it('puts a public hold in lane 1', async () => {
    const busy = await world.addProfessional({ maxSimultaneous: 2 });
    world.setNow(START);

    const created = await world.inTenant((tx) =>
      createHold(createSchedulingPorts(tx, { keys: world.keys }), {
        request: {
          professionalId: busy.professionalId,
          locationId: world.centro,
          appointmentTypeId: world.consulta,
          local: { date: world.monday(15), time: '10:00' },
        },
        actor: { userId: world.reception.user.id, permissions: new Set(), professionalId: null },
        now: START,
        origin: 'public',
        sourceKey: 'another-anonymous-session',
      }),
    );

    expect(created.origin).toBe('public');
    expect((await holdRow(created.id))?.lane).toBe(1);
  });
});

describe('the hold.expire job', () => {
  it('marks the holds that ran out as expired and leaves the rest alone (no waitlist, no messages)', async () => {
    world.setNow(START);
    const stale = await newHold(16, '10:00');
    const fresh = await newHold(16, '11:00', world.admin);
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE slot_hold SET expires_at = now() - interval '1 minute' WHERE id = ${stale.id}`,
      ),
    );

    const result = await runJob(runtime.db, holdExpireJob, {
      id: crypto.randomUUID(),
      name: HOLD_EXPIRE_JOB,
      data: { tenantId: world.tenant.id },
      enqueuedAt: new Date(),
      retryCount: 0,
    });

    expect(result).toEqual({ status: 'completed' });
    expect((await holdRow(stale.id))?.status).toBe('expired');
    expect((await holdRow(fresh.id))?.status).toBe('active');
    const rows = await world.inTenant((tx) => occupancyOf(tx, world.doctor.professionalId));
    expect(rows.find((row) => row.slot_hold_id === stale.id)?.active).toBe(false);
  });
});

describe('the worker role', () => {
  it('ends the holds that ran out by itself, shortly after they do', async () => {
    world.setNow(START);
    const stale = await newHold(17, '10:00');
    await world.inTenant((tx) =>
      tx.execute(
        sql`UPDATE slot_hold SET expires_at = now() - interval '1 minute' WHERE id = ${stale.id}`,
      ),
    );
    const worker = await startWorker({
      databaseUrl: inject('runtimeUrl'),
      sealerDatabaseUrl: inject('sealerUrl'),
      log: { info: () => undefined, error: () => undefined },
      pollingIntervalSeconds: 0.5,
      tenantJobs: [{ definition: holdExpireJob, everyMs: 300 }],
    });

    try {
      await eventually(async () =>
        (await holdRow(stale.id))?.status === 'expired' ? true : undefined,
      );
    } finally {
      await worker.stop();
    }

    expect((await holdRow(stale.id))?.status).toBe('expired');
  }, 60_000);
});

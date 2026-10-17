import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { appointment, appointmentEvent, slotHold } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  at,
  createSchedulingWorld,
  insertAppointment,
  insertHold,
  occupancyOf,
  type SchedulingWorld,
} from '../support/scheduling.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';

let runtime: DbHandle;
let tenant: TestTenant;
let world: SchedulingWorld;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'sched-schema' });
  world = await createSchedulingWorld(runtime, tenant.id);
});

afterAll(async () => {
  await runtime.close();
});

/** The SQLSTATE of the failure, or undefined when the work succeeded. Pass a thunk so nothing starts early. */
const failure = (work: Promise<unknown> | (() => Promise<unknown>)) =>
  (typeof work === 'function' ? work() : work).then(
    () => undefined,
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code,
  );

const run = <T>(fn: Parameters<typeof asTenant<T>>[2]) => asTenant(runtime, tenant.id, fn);

/** A professional of their own, so a test does not collide with the others on the same hours. */
async function freshProfessional(maxSimultaneous = 1) {
  const { createTestProfessional } = await import('../support/users.js');
  const created = await createTestProfessional(runtime, tenant.id);
  if (maxSimultaneous > 1) {
    await run((tx) =>
      tx.execute(
        sql`UPDATE professional SET max_simultaneous = ${maxSimultaneous} WHERE id = ${created.professionalId}`,
      ),
    );
  }
  return created.professionalId;
}

describe('the appointment table', () => {
  it('refuses a ninth status, a non-positive length and an unknown source', async () => {
    const doctor = await freshProfessional();
    const book = (values: { start?: Date; end?: Date; status?: string; source?: string }) =>
      run((tx) =>
        tx.execute(sql`INSERT INTO appointment
          (tenant_id, patient_id, professional_id, location_id, appointment_type_id, starts_at, ends_at, status, source)
          VALUES (${tenant.id}, ${world.patientId}, ${doctor}, ${world.locationId}, ${world.typeId},
                  ${(values.start ?? at(0)).toISOString()}, ${(values.end ?? at(30)).toISOString()},
                  ${values.status ?? 'scheduled'}, ${values.source ?? 'staff'})`),
      );

    expect(await failure(book({ status: 'rescheduled' }))).toBe('23514');
    expect(await failure(book({ end: at(0) }))).toBe('23514');
    expect(await failure(book({ source: 'fax' }))).toBe('23514');
    expect(await failure(book({}))).toBeUndefined();
  });

  it('cannot point at a patient, professional, location or type of another organization', async () => {
    const other = await createTestTenant(runtime, { slug: 'sched-schema-b' });
    const foreign = await createSchedulingWorld(runtime, other.id);

    const crossed = (overrides: Partial<SchedulingWorld>) =>
      run((tx) =>
        insertAppointment(tx, { ...world, ...overrides }, { start: at(600), minutes: 30 }),
      );

    expect(await failure(crossed({ patientId: foreign.patientId }))).toBe('23503');
    expect(await failure(crossed({ professionalId: foreign.professionalId }))).toBe('23503');
    expect(await failure(crossed({ locationId: foreign.locationId }))).toBe('23503');
    expect(await failure(crossed({ typeId: foreign.typeId }))).toBe('23503');
  });

  it('only allows an identity confirmation when the identity is confirmed', async () => {
    const doctor = await freshProfessional();
    const bad = run((tx) =>
      tx.execute(sql`INSERT INTO appointment
        (tenant_id, patient_id, professional_id, location_id, appointment_type_id, starts_at, ends_at,
         identity_confirmed, identity_confirmation)
        VALUES (${tenant.id}, ${world.patientId}, ${doctor}, ${world.locationId}, ${world.typeId},
                ${at(0).toISOString()}, ${at(30).toISOString()}, false, 'staff')`),
    );

    expect(await failure(bad)).toBe('23514');
  });

  it('is never deleted or truncated by the application role', async () => {
    const created = await run((tx) =>
      insertAppointment(tx, world, { start: at(2000), minutes: 15 }),
    );

    const deletion = run((tx) => tx.delete(appointment).where(eq(appointment.id, created.id)));

    expect(await failure(deletion)).toBe('42501');
  });
});

describe('the appointment history', () => {
  it('records events and cannot be rewritten or deleted', async () => {
    const created = await run((tx) =>
      insertAppointment(tx, world, { start: at(3000), minutes: 15 }),
    );
    const insertEvent = () =>
      run((tx) =>
        tx
          .insert(appointmentEvent)
          .values({
            tenantId: tenant.id,
            appointmentId: created.id,
            kind: 'created',
            toStatus: 'scheduled',
          })
          .returning(),
      );

    const [event] = await insertEvent();

    expect(event).toMatchObject({ kind: 'created', actorKind: 'staff', details: {} });
    expect(
      await failure(
        run((tx) =>
          tx
            .update(appointmentEvent)
            .set({ kind: 'status_changed' })
            .where(eq(appointmentEvent.id, event?.id ?? '')),
        ),
      ),
    ).toBe('42501');
    expect(
      await failure(
        run((tx) => tx.delete(appointmentEvent).where(eq(appointmentEvent.id, event?.id ?? ''))),
      ),
    ).toBe('42501');
  });

  it('refuses an event kind that does not exist ("rescheduled" is an event, not a status)', async () => {
    const created = await run((tx) =>
      insertAppointment(tx, world, { start: at(3100), minutes: 15 }),
    );

    const bad = run((tx) =>
      tx.insert(appointmentEvent).values({
        tenantId: tenant.id,
        appointmentId: created.id,
        kind: 'moved',
      }),
    );

    expect(await failure(bad)).toBe('23514');
  });
});

describe('the occupancy of a professional (one conflict surface)', () => {
  it('rejects an overlap in one lane (23P01) and accepts back to back', async () => {
    const doctor = await freshProfessional();
    await run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(0) }));

    const overlap = () =>
      run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(15) }));
    const backToBack = () =>
      run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(30) }));

    expect(await failure(overlap)).toBe('23P01');
    expect(await failure(backToBack)).toBeUndefined();
  });

  it('counts the buffer as occupied time, in both directions', async () => {
    const doctor = await freshProfessional();
    await run((tx) =>
      insertAppointment(tx, world, { professionalId: doctor, start: at(0), bufferMinutes: 10 }),
    );

    const insideBuffer = () =>
      run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(30) }));
    const afterBuffer = () =>
      run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(40) }));
    const ownBufferRunsIntoNext = () =>
      run((tx) =>
        insertAppointment(tx, world, {
          professionalId: doctor,
          start: at(-30),
          bufferMinutes: 10,
        }),
      );

    expect(await failure(insideBuffer)).toBe('23P01');
    expect(await failure(afterBuffer)).toBeUndefined();
    expect(await failure(ownBufferRunsIntoNext)).toBe('23P01');
  });

  it('lets a second lane hold a simultaneous appointment, up to the professional capacity', async () => {
    const doctor = await freshProfessional(2);
    await run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(0) }));

    const second = () =>
      run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(0), lane: 2 }));
    const third = () =>
      run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(0), lane: 3 }));

    expect(await failure(second)).toBeUndefined();
    expect(await failure(third)).toBe('23514');
  });

  it('refuses the lane 2 of a professional who is not allowed to overbook', async () => {
    const doctor = await freshProfessional(1);

    const second = () =>
      run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(0), lane: 2 }));

    expect(await failure(second)).toBe('23514');
  });

  it('keeps working on a lane-2 appointment after the capacity was lowered (JD-S2 S2)', async () => {
    const doctor = await freshProfessional(2);
    await run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(0) }));
    const overbooked = await run((tx) =>
      insertAppointment(tx, world, { professionalId: doctor, start: at(0), lane: 2 }),
    );
    await run((tx) =>
      tx.execute(sql`UPDATE professional SET max_simultaneous = 1 WHERE id = ${doctor}`),
    );
    const change = (set: Record<string, unknown>) => () =>
      run((tx) => tx.update(appointment).set(set).where(eq(appointment.id, overbooked.id)));

    // Existing appointments keep their lane: a status change is not a new lane.
    expect(await failure(change({ status: 'confirmed' }))).toBeUndefined();
    expect(await failure(change({ status: 'checked_in' }))).toBeUndefined();
    expect(await failure(change({ status: 'cancelled' }))).toBeUndefined();
    // Moving into a lane above the capacity, or booking a new one there, is still refused.
    expect(await failure(change({ status: 'scheduled', lane: 3 }))).toBe('23514');
    expect(
      await failure(() =>
        run((tx) =>
          insertAppointment(tx, world, { professionalId: doctor, start: at(120), lane: 2 }),
        ),
      ),
    ).toBe('23514');
  });

  it('does not let the application role write the occupancy directly', async () => {
    const doctor = await freshProfessional();
    const forged = () =>
      run((tx) =>
        tx.execute(sql`INSERT INTO slot_occupancy
        (tenant_id, professional_id, location_id, lane, during, active, slot_hold_id)
        VALUES (${tenant.id}, ${doctor}, ${world.locationId}, 1, tstzrange(now(), now() + interval '1 hour'), true, gen_random_uuid())`),
      );

    expect(await failure(forged)).toBe('42501');
    expect(await failure(run((tx) => tx.execute(sql`DELETE FROM slot_occupancy`)))).toBe('42501');
  });
});

describe('triggers keep the occupancy in step with the appointment (task 2.5)', () => {
  const OCCUPYING = [
    'pending_approval',
    'scheduled',
    'confirmed',
    'checked_in',
    'in_progress',
    'attended',
  ];
  const FREEING = ['no_show', 'cancelled'];

  it.each(OCCUPYING)('occupies time while the appointment is %s', async (status) => {
    const doctor = await freshProfessional();

    await run((tx) =>
      insertAppointment(tx, world, { professionalId: doctor, start: at(0), status }),
    );

    const rows = await run((tx) => occupancyOf(tx, doctor));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ active: true, lane: 1 });
  });

  it.each(FREEING)('frees the time when the appointment is %s', async (status) => {
    const doctor = await freshProfessional();

    await run((tx) =>
      insertAppointment(tx, world, { professionalId: doctor, start: at(0), status }),
    );

    expect((await run((tx) => occupancyOf(tx, doctor)))[0]).toMatchObject({ active: false });
    // The slot is reusable at once.
    expect(
      await failure(
        run((tx) => insertAppointment(tx, world, { professionalId: doctor, start: at(0) })),
      ),
    ).toBeUndefined();
  });

  it('follows every change of status, time, lane and professional', async () => {
    const doctor = await freshProfessional(2);
    const colleague = await freshProfessional();
    const created = await run((tx) =>
      insertAppointment(tx, world, { professionalId: doctor, start: at(0) }),
    );
    const update = (set: Record<string, unknown>) =>
      run((tx) => tx.update(appointment).set(set).where(eq(appointment.id, created.id)));

    await update({ status: 'cancelled' });
    expect((await run((tx) => occupancyOf(tx, doctor)))[0]?.active).toBe(false);
    await update({ status: 'scheduled' });
    expect((await run((tx) => occupancyOf(tx, doctor)))[0]?.active).toBe(true);

    await update({ startsAt: at(60), endsAt: at(75), bufferMinutes: 5 });
    expect((await run((tx) => occupancyOf(tx, doctor)))[0]?.during).toContain('11:20:00+00');

    await update({ lane: 2 });
    expect((await run((tx) => occupancyOf(tx, doctor)))[0]?.lane).toBe(2);

    // A colleague who cannot overbook has only lane 1.
    await update({ professionalId: colleague, lane: 1 });
    expect(await run((tx) => occupancyOf(tx, doctor))).toHaveLength(0);
    expect(await run((tx) => occupancyOf(tx, colleague))).toHaveLength(1);
  });

  it('keeps one occupancy row per appointment however often it changes', async () => {
    const doctor = await freshProfessional();
    const created = await run((tx) =>
      insertAppointment(tx, world, { professionalId: doctor, start: at(0) }),
    );

    for (const status of ['confirmed', 'checked_in', 'in_progress', 'attended']) {
      await run((tx) =>
        tx.update(appointment).set({ status }).where(eq(appointment.id, created.id)),
      );
    }

    expect(await run((tx) => occupancyOf(tx, doctor))).toHaveLength(1);
  });

  it('occupies time for an active hold and frees it when the hold ends', async () => {
    const doctor = await freshProfessional();
    const hold = await run((tx) => insertHold(tx, world, { professionalId: doctor, start: at(0) }));
    expect((await run((tx) => occupancyOf(tx, doctor)))[0]).toMatchObject({
      active: true,
      slot_hold_id: hold.id,
      appointment_id: null,
    });
    const clash = run((tx) =>
      insertAppointment(tx, world, { professionalId: doctor, start: at(10) }),
    );
    expect(await failure(clash)).toBe('23P01');

    for (const status of ['expired', 'released', 'invalidated', 'converted']) {
      await run((tx) =>
        tx.update(slotHold).set({ status: 'active' }).where(eq(slotHold.id, hold.id)),
      );
      await run((tx) => tx.update(slotHold).set({ status }).where(eq(slotHold.id, hold.id)));
      expect((await run((tx) => occupancyOf(tx, doctor)))[0]?.active, status).toBe(false);
    }
  });

  it('never deletes a hold', async () => {
    const hold = await run((tx) => insertHold(tx, world, { start: at(5000) }));

    expect(await failure(run((tx) => tx.delete(slotHold).where(eq(slotHold.id, hold.id))))).toBe(
      '42501',
    );
  });
});

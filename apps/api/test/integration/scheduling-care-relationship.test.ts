import type { AppointmentDto } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { clinicalPolicies, tenantPolicies } from '../../src/db/schema/_helpers.js';
import { appointment } from '../../src/db/schema/scheduling.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import {
  createSchedulingHttpWorld,
  type Doctor,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';
import { insertPatient } from '../support/scheduling.js';

/**
 * The appointment source of the care relationship (design 3.6, D2 + D14 + D15), proven through the
 * real clinical policies on a test-only table: a professional sees a patient's clinical item only
 * when `care_relationship` says they treat them, and that table is fed by a trigger on the
 * appointment, never by application code.
 */

let runtime: DbHandle;
let owner: pg.Client;
let world: SchedulingHttpWorld;
let author: Doctor;
const statements = (text: string) => text.split('\n--> statement-breakpoint\n');

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  world = await createSchedulingHttpWorld(runtime, { slug: 'sched-care' });
  // A professional who wrote clinical items about other people's patients (the note exists, the
  // question is who may read it).
  author = await world.addProfessional();
  await owner.query(`
    CREATE TABLE test_care_note (
      id uuid PRIMARY KEY DEFAULT app.uuid_v7(),
      tenant_id uuid NOT NULL REFERENCES tenant (id),
      patient_id uuid NOT NULL,
      author_professional_id uuid NOT NULL,
      visibility text NOT NULL DEFAULT 'default',
      template_kind text,
      body text NOT NULL DEFAULT 'clinical content'
    )`);
  for (const statement of [
    ...statements(tenantPolicies('test_care_note')),
    ...statements(clinicalPolicies('test_care_note')),
  ]) {
    await owner.query(statement);
  }
  await owner.query('GRANT SELECT, INSERT, UPDATE, DELETE ON test_care_note TO app_rw');
});

afterAll(async () => {
  await owner.query('DROP TABLE IF EXISTS test_care_note');
  await owner.end();
  await world.close();
  await runtime.close();
});

/** A patient with one clinical item by the colleague (so there is something to read or not). */
async function patientWithNote(): Promise<string> {
  const patientId = await world.inTenant((tx) => insertPatient(tx, world.tenant.id));
  await createWithTenant(runtime.db)(
    {
      tenantId: world.tenant.id,
      userId: author.user.id,
      actingProfessionalId: author.professionalId,
    },
    (tx) =>
      tx.execute(
        sql`INSERT INTO test_care_note (tenant_id, patient_id, author_professional_id)
              VALUES (${world.tenant.id}, ${patientId}, ${author.professionalId})`,
      ),
  );
  return patientId;
}

/** How many of the patient's clinical items this professional can read. */
function readable(professional: Doctor, patientId: string): Promise<number> {
  return createWithTenant(runtime.db)(
    {
      tenantId: world.tenant.id,
      userId: professional.user.id,
      actingProfessionalId: professional.professionalId,
    },
    async (tx) => {
      const result = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM test_care_note WHERE patient_id = ${patientId}`,
      );
      return result.rows[0]?.n ?? -1;
    },
  );
}

async function counters(patientId: string, professionalId: string) {
  const result = await world.inTenant((tx) =>
    tx.execute<{ qualifying_appointments: number; active: boolean }>(
      sql`SELECT qualifying_appointments, active FROM care_relationship
           WHERE patient_id = ${patientId} AND professional_id = ${professionalId}`,
    ),
  );
  return result.rows[0] ?? { qualifying_appointments: 0, active: false };
}

const post = (
  id: string,
  action: string,
  who = world.reception,
  body: Record<string, unknown> = {},
) => world.act({ id }, action, who, body);

/** Books `patientId` with the doctor; `byReception` decides if the identity starts confirmed. */
async function bookFor(patientId: string, weeksAfter: number, byReception: boolean) {
  const response = await world.api.post(
    '/appointments',
    byReception ? world.reception : world.doctor,
    {
      ...(await world.bookingBody(weeksAfter, '10:00')),
      patientId,
    },
  );
  expect(response.statusCode, response.body).toBe(201);
  return response.json<AppointmentDto>();
}

describe('what the appointment gives a professional', () => {
  it('gives nothing before the appointment, and access once reception booked it (identity confirmed)', async () => {
    const patientId = await patientWithNote();
    expect(await readable(world.doctor, patientId)).toBe(0);

    await bookFor(patientId, 1, true);

    expect(await readable(world.doctor, patientId)).toBe(1);
    expect(await counters(patientId, world.doctor.professionalId)).toMatchObject({
      qualifying_appointments: 1,
      active: true,
    });
  });

  it('gives nothing while the identity is unconfirmed (the professional booked themselves), and access when staff confirm', async () => {
    const patientId = await patientWithNote();
    const created = await bookFor(patientId, 2, false);

    expect(created.identityConfirmed).toBe(false);
    expect(await readable(world.doctor, patientId)).toBe(0);
    expect((await counters(patientId, world.doctor.professionalId)).active).toBe(false);

    await post(created.id, 'check-in', world.reception, { confirmIdentity: true });

    expect(await readable(world.doctor, patientId)).toBe(1);
  });

  it('keeps access after a confirmed no-show and after attendance', async () => {
    const patientId = await patientWithNote();
    const noShow = await bookFor(patientId, 3, true);
    world.setNow(new Date(Date.parse(noShow.startsAt) + 60_000));
    await post(noShow.id, 'no-show');
    world.setNow(new Date('2031-05-05T12:00:00.000Z'));
    expect(await readable(world.doctor, patientId)).toBe(1);

    const other = await patientWithNote();
    const attended = await bookFor(other, 3, true);
    await post(attended.id, 'check-in');
    await post(attended.id, 'start', world.doctor);
    await post(attended.id, 'attend', world.doctor);

    expect(await readable(world.doctor, other)).toBe(1);
  });

  it('gives nothing for an unconfirmed no-show', async () => {
    const patientId = await patientWithNote();
    const created = await bookFor(patientId, 4, false);
    world.setNow(new Date(Date.parse(created.startsAt) + 60_000));
    await post(created.id, 'no-show');
    world.setNow(new Date('2031-05-05T12:00:00.000Z'));

    expect(await readable(world.doctor, patientId)).toBe(0);
  });

  it('gives nothing while the booking is pending approval, and access after the approval', async () => {
    const patientId = await patientWithNote();
    const created = await bookFor(patientId, 5, true);
    expect(await readable(world.doctor, patientId)).toBe(1);

    await world.inTenant((tx) =>
      tx
        .update(appointment)
        .set({ status: 'pending_approval' })
        .where(eq(appointment.id, created.id)),
    );
    expect(await readable(world.doctor, patientId)).toBe(0);

    await post(created.id, 'approve');
    expect(await readable(world.doctor, patientId)).toBe(1);
  });

  it('gives nothing for a cancelled appointment that was never attended', async () => {
    const patientId = await patientWithNote();
    const created = await bookFor(patientId, 6, true);
    expect(await readable(world.doctor, patientId)).toBe(1);

    await post(created.id, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    expect(await readable(world.doctor, patientId)).toBe(0);
    expect(await counters(patientId, world.doctor.professionalId)).toMatchObject({
      qualifying_appointments: 0,
      active: false,
    });
  });

  it('keeps the relationship while any qualifying appointment is left', async () => {
    const patientId = await patientWithNote();
    const first = await bookFor(patientId, 7, true);
    const second = await bookFor(patientId, 8, true);
    expect((await counters(patientId, world.doctor.professionalId)).qualifying_appointments).toBe(
      2,
    );

    await post(first.id, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });
    expect(await readable(world.doctor, patientId)).toBe(1);
    await post(second.id, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });

    expect(await readable(world.doctor, patientId)).toBe(0);
  });

  it('follows a correction of a status', async () => {
    const patientId = await patientWithNote();
    const created = await bookFor(patientId, 9, true);
    await post(created.id, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });
    expect(await readable(world.doctor, patientId)).toBe(0);

    await post(created.id, 'correct', world.reception, {
      toStatus: 'scheduled',
      reasonCode: 'entered_by_mistake',
    });

    expect(await readable(world.doctor, patientId)).toBe(1);
  });
});

describe('who gets the relationship when the appointment moves', () => {
  it('moves it with a reassignment', async () => {
    const patientId = await patientWithNote();
    const created = await bookFor(patientId, 10, true);
    expect(await readable(world.doctor, patientId)).toBe(1);
    expect(await readable(world.colleague, patientId)).toBe(0);

    const response = await post(created.id, 'reschedule', world.reception, {
      expectedVersion: 1,
      professionalId: world.colleague.professionalId,
    });

    expect(response.statusCode).toBe(200);
    expect(await readable(world.doctor, patientId)).toBe(0);
    expect(await readable(world.colleague, patientId)).toBe(1);
  });

  it('never reaches the matched patient when the match is rejected, and starts the new patient', async () => {
    const matched = await patientWithNote();
    const created = await bookFor(matched, 11, false);
    const other = await patientWithNote();

    const response = await post(created.id, 'detach-patient', world.reception, {
      resolution: 'move_to_patient',
      patientId: other,
    });

    expect(response.statusCode).toBe(200);
    expect(await readable(world.doctor, matched)).toBe(0);
    expect(await readable(world.doctor, other)).toBe(1);
  });
});

describe('the trigger, not the application, keeps the counters', () => {
  it('counts correctly when appointments are booked at the same time', async () => {
    const patientId = await patientWithNote();
    const responses = await Promise.all(
      [12, 13, 14, 15, 16, 17].map(async (weeks) =>
        world.api.post('/appointments', world.reception, {
          ...(await world.bookingBody(weeks, '10:00')),
          patientId,
        }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([
      201, 201, 201, 201, 201, 201,
    ]);
    expect((await counters(patientId, world.doctor.professionalId)).qualifying_appointments).toBe(
      6,
    );
  });

  it('follows a direct change of the row too: the application cannot forget to update it', async () => {
    const patientId = await patientWithNote();
    const created = await bookFor(patientId, 18, true);

    await world.inTenant((tx) =>
      tx
        .update(appointment)
        .set({ identityConfirmed: false, identityConfirmation: null })
        .where(eq(appointment.id, created.id)),
    );
    expect(await readable(world.doctor, patientId)).toBe(0);

    await world.inTenant((tx) =>
      tx.update(appointment).set({ identityConfirmed: true }).where(eq(appointment.id, created.id)),
    );
    expect(await readable(world.doctor, patientId)).toBe(1);
  });

  it('does not let the application write the relationship itself', async () => {
    const patientId = await patientWithNote();

    const forge = world.inTenant((tx) =>
      tx.execute(
        sql`INSERT INTO care_relationship (tenant_id, patient_id, professional_id, qualifying_appointments)
              VALUES (${world.tenant.id}, ${patientId}, ${world.doctor.professionalId}, 1)`,
      ),
    );

    await expect(forge).rejects.toMatchObject({ cause: { code: '42501' } });
    expect(await readable(world.doctor, patientId)).toBe(0);
  });
});

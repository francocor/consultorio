import { randomUUID } from 'node:crypto';

import { Problem, type NoteDto } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { encounter } from '../../src/db/schema/clinical.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asProfessional } from '../support/clinical.js';
import {
  createSchedulingHttpWorld,
  type Doctor,
  type SchedulingHttpWorld,
} from '../support/scheduling-world.js';

/**
 * Decision D20 with the real agenda behind it. Clinical and scheduling are both in the application
 * now, so an encounter can name a real appointment and the care relationship that the appointment
 * source feeds is the one the clinical gate reads:
 *
 * - an appointment with CONFIRMED identity (booked by staff, or confirmed at check-in) is a care
 *   source: the professional of the appointment may open an encounter from it;
 * - an appointment whose identity nobody confirmed (a professional booking themselves, an online
 *   match) is not: opening from it is refused, with a deny audit entry;
 * - an appointment of another professional or another patient is refused;
 * - the database says the same (composite foreign keys and the encounter guard).
 */
let runtime: DbHandle;
let world: SchedulingHttpWorld;
let weeks = 0;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createSchedulingHttpWorld(runtime, { slug: 'clinical-appointments' });
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** A patient somebody else (the colleague) already wrote about: opening needs a relationship. */
async function patientWithRecord(): Promise<string> {
  const patientId = await world.freshPatient();
  const draft = await world.api.post('/encounters', world.colleague, {
    patientId,
    templateKind: 'general',
  });
  expect(draft.statusCode, draft.body).toBe(201);
  const note = draft.json<NoteDto>();
  await world.api.put(`/encounters/${note.encounterId}/note/draft`, world.colleague, {
    content: { reasonForConsultation: 'Consulta' },
    baseRevision: 0,
  });
  const signed = await world.api.post(`/notes/${note.id}/sign`, world.colleague, {
    expectedRevision: 1,
  });
  expect(signed.statusCode, signed.body).toBe(200);
  return patientId;
}

const nextWeek = () => {
  weeks += 1;
  return weeks;
};

const open = (by: Doctor, body: object) =>
  world.api.post('/encounters', by, { templateKind: 'general', ...body });

async function denials(patientId: string) {
  return world.inTenant((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.patientId, patientId))),
  );
}

describe('an appointment with confirmed identity is a care source', () => {
  it('lets the professional of the appointment open an encounter from it, and only then', async () => {
    const patientId = await patientWithRecord();

    const before = await open(world.doctor, { patientId });
    expect(before.statusCode).toBe(403);
    expect(Problem.parse(before.json()).code).toBe('forbidden');

    // Reception books the patient with the doctor: identity confirmed by a person.
    const booked = await world.book(nextWeek(), '09:00', { patientId });
    expect(booked.identityConfirmed).toBe(true);
    const after = await open(world.doctor, { patientId, appointmentId: booked.id });

    expect(after.statusCode, after.body).toBe(201);
    expect(after.json<NoteDto>().appointmentId).toBe(booked.id);
    const [stored] = await asProfessional(
      runtime,
      world.tenant.id,
      world.doctor.professionalId,
      (tx) => tx.select().from(encounter).where(eq(encounter.appointmentId, booked.id)),
    );
    expect(stored).toMatchObject({ patientId, authorProfessionalId: world.doctor.professionalId });
  });

  it('also lets them open an encounter without naming the appointment: the relationship is the same', async () => {
    const patientId = await patientWithRecord();
    await world.book(nextWeek(), '09:30', { patientId });

    const response = await open(world.doctor, { patientId });

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<NoteDto>().appointmentId).toBeNull();
  });

  it('stops counting when the appointment is cancelled', async () => {
    const patientId = await patientWithRecord();
    const booked = await world.book(nextWeek(), '10:00', { patientId });
    const cancelled = await world.act(booked, 'cancel', world.reception, {
      cancelledBy: 'patient',
      reasonCode: 'illness',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);

    const response = await open(world.doctor, { patientId, appointmentId: booked.id });

    expect(response.statusCode).toBe(403);
    const reasons = (await denials(patientId)).map((row) => row.reason);
    expect(reasons).toContain('appointment_mismatch');
  });
});

describe('an appointment whose identity nobody confirmed is not', () => {
  it('refuses the encounter with a deny audit entry, and opens once identity is confirmed', async () => {
    const patientId = await patientWithRecord();
    // The professional booking an existing patient with themselves: nobody else looked at who it is.
    const selfBooked = await world.book(nextWeek(), '10:30', { patientId }, world.doctor);
    expect(selfBooked.identityConfirmed).toBe(false);

    const named = await open(world.doctor, { patientId, appointmentId: selfBooked.id });
    const unnamed = await open(world.doctor, { patientId });

    expect(named.statusCode).toBe(403);
    expect(unnamed.statusCode).toBe(403);
    const rows = await denials(patientId);
    expect(rows.map((row) => row.reason)).toEqual(
      expect.arrayContaining([
        'appointment_identity_unconfirmed',
        'encounter_requires_relationship',
      ]),
    );
    expect(rows.at(-1)).toMatchObject({ outcome: 'deny', actorUserId: world.doctor.user.id });
    const written = await asProfessional(
      runtime,
      world.tenant.id,
      world.doctor.professionalId,
      (tx) => tx.select().from(encounter).where(eq(encounter.appointmentId, selfBooked.id)),
    );
    expect(written).toEqual([]);

    // Reception confirms the identity at check-in; the same appointment now opens an encounter.
    const checkedIn = await world.act(selfBooked, 'check-in', world.reception, {
      confirmIdentity: true,
    });
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    const allowed = await open(world.doctor, { patientId, appointmentId: selfBooked.id });
    expect(allowed.statusCode, allowed.body).toBe(201);
  });
});

describe('an appointment of somebody else is refused', () => {
  it("refuses another professional's appointment, with a deny audit entry", async () => {
    const patientId = await patientWithRecord();
    const mine = await world.book(nextWeek(), '11:00', { patientId });

    const response = await open(world.colleague, { patientId, appointmentId: mine.id });

    expect(response.statusCode).toBe(403);
    expect((await denials(patientId)).map((row) => row.reason)).toContain('appointment_mismatch');
  });

  it('refuses an appointment of another patient, and one that does not exist', async () => {
    const patientId = await patientWithRecord();
    await world.book(nextWeek(), '11:30', { patientId });
    const other = await world.book(nextWeek(), '12:00');

    const wrongPatient = await open(world.doctor, { patientId, appointmentId: other.id });
    const missing = await open(world.doctor, { patientId, appointmentId: randomUUID() });

    expect(wrongPatient.statusCode).toBe(403);
    expect(missing.statusCode).toBe(403);
  });
});

describe('the database says the same', () => {
  const insertEncounter = (by: Doctor, patientId: string, appointmentId: string | null) =>
    asProfessional(runtime, world.tenant.id, by.professionalId, (tx) =>
      tx.insert(encounter).values({
        tenantId: world.tenant.id,
        patientId,
        authorProfessionalId: by.professionalId,
        templateKind: 'general',
        visibility: 'default',
        appointmentId,
      }),
    );

  it('has composite foreign keys from the encounter to the appointment and from the document to the encounter', async () => {
    const keys = await world.inTenant((tx) =>
      tx.execute<{ conname: string; definition: string }>(
        sql`SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
            WHERE conname IN ('encounter_appointment_fkey', 'document_encounter_fkey')`,
      ),
    );
    const byName = new Map(keys.rows.map((row) => [row.conname, row.definition]));
    expect(byName.get('encounter_appointment_fkey')).toContain(
      'FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointment(tenant_id, id)',
    );
    expect(byName.get('document_encounter_fkey')).toContain(
      'FOREIGN KEY (tenant_id, encounter_id) REFERENCES encounter(tenant_id, id)',
    );
  });

  it('refuses an appointment that does not exist', async () => {
    const patientId = await world.freshPatient();

    await expect(insertEncounter(world.doctor, patientId, randomUUID())).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });

  it('refuses an appointment of another professional, of another patient, or one with unconfirmed identity', async () => {
    const patientId = await patientWithRecord();
    const confirmed = await world.book(nextWeek(), '12:30', { patientId });
    const unconfirmed = await world.book(nextWeek(), '12:30', { patientId }, world.doctor);
    const otherPatient = await world.book(nextWeek(), '09:00');

    await expect(insertEncounter(world.colleague, patientId, confirmed.id)).rejects.toMatchObject({
      cause: { code: '23503' },
    });
    await expect(insertEncounter(world.doctor, patientId, otherPatient.id)).rejects.toMatchObject({
      cause: { code: '23503' },
    });
    await expect(insertEncounter(world.doctor, patientId, unconfirmed.id)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(insertEncounter(world.doctor, patientId, confirmed.id)).resolves.toBeDefined();
  });
});

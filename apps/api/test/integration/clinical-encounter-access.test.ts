import { randomUUID } from 'node:crypto';

import { Problem, type NoteDto } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { careRelationship } from '../../src/db/schema/care.js';
import { encounter } from '../../src/db/schema/clinical.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';
import { asProfessional, openDraft } from '../support/clinical.js';
import { asTenant } from '../support/tenants.js';

/**
 * Who may open an encounter (decision D20, clinical-records "Opening an encounter needs a care
 * relationship"). Opening one used to make the author a treating professional on the spot, so any
 * professional could read any patient's record by posting an encounter. Now the relationship has to
 * come from somewhere else: an appointment with confirmed identity, a care assignment or an earlier
 * SIGNED encounter. The one exception is a patient nobody has written about yet.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let author: Professional;
let intruder: Professional;
let colleague: Professional;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createClinicalWorld(runtime, 'clinical-encounter-access');
  author = await world.professional();
  intruder = await world.professional();
  colleague = await world.professional();
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const open = (by: Professional, body: object) => world.api.post('/encounters', by.session, body);

async function encountersOf(by: Professional, patientId: string) {
  return asProfessional(runtime, world.tenant.id, by.professionalId, (tx) =>
    tx.select({ id: encounter.id }).from(encounter).where(eq(encounter.patientId, patientId)),
  );
}

async function relationship(patientId: string, by: Professional) {
  const rows = await asTenant(runtime, world.tenant.id, (tx) =>
    tx.select().from(careRelationship).where(eq(careRelationship.patientId, patientId)),
  );
  return rows.find((row) => row.professionalId === by.professionalId);
}

async function signed(by: Professional, patientId: string): Promise<NoteDto> {
  const draft = await world.open(by, patientId);
  const saved = await world.api.put(`/encounters/${draft.encounterId}/note/draft`, by.session, {
    content: { reasonForConsultation: 'Consulta' },
    baseRevision: 0,
  });
  expect(saved.statusCode).toBe(200);
  const response = await world.api.post(`/notes/${draft.id}/sign`, by.session, {
    expectedRevision: 1,
  });
  return response.json<NoteDto>();
}

describe('the exploit: opening an encounter to read a record', () => {
  it('is refused for a patient other professionals have written about, and grants nothing', async () => {
    const patientId = await world.patient([author]);
    const note = await signed(author, patientId);

    const attempt = await open(intruder, { patientId, templateKind: 'general' });

    expect(attempt.statusCode).toBe(403);
    expect(Problem.parse(attempt.json()).code).toBe('forbidden');
    expect(await encountersOf(intruder, patientId)).toEqual([]);
    // Nothing was granted: the history, the addenda and the error marks stay out of reach.
    expect((await world.api.get(`/notes/${note.id}`, intruder.session)).statusCode).toBe(404);
    expect(
      (
        await world.api.post(`/notes/${note.id}/addenda`, intruder.session, {
          kind: 'correction',
          reason: 'Motivo',
          text: 'Texto',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await world.api.post(`/notes/${note.id}/entered-in-error`, intruder.session, {
          reason: 'x',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await world.api.get(`/patients/${patientId}/clinical/timeline`, intruder.session))
        .statusCode,
    ).toBe(403);
    expect(await relationship(patientId, intruder)).toBeUndefined();
  });

  it('writes a deny audit entry naming the patient and the reason', async () => {
    const patientId = await world.patient([author]);
    await signed(author, patientId);

    await open(intruder, { patientId, templateKind: 'general' });

    const rows = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.patientId, patientId))),
    );
    expect(rows.at(-1)).toMatchObject({
      outcome: 'deny',
      actorUserId: intruder.session.user.id,
      reason: 'encounter_requires_relationship',
    });
  });

  it('is refused for a patient who only has a care relationship with somebody else (an assignment)', async () => {
    const patientId = await world.patient([colleague]);

    const attempt = await open(intruder, { patientId, templateKind: 'general' });

    expect(attempt.statusCode).toBe(403);
  });

  it("is refused while the only footprint is somebody else's draft", async () => {
    const patientId = await world.patient();
    await world.open(author, patientId);

    const attempt = await open(intruder, { patientId, templateKind: 'general' });

    expect(attempt.statusCode).toBe(403);
  });

  it('is refused even when the draft was marked in error (the footprint stays)', async () => {
    const patientId = await world.patient();
    const draft = await world.open(author, patientId);
    await world.api.post(`/notes/${draft.id}/entered-in-error`, author.session, {
      reason: 'Equivocado',
    });

    expect((await open(intruder, { patientId, templateKind: 'general' })).statusCode).toBe(403);
  });
});

describe('the sources of a care relationship', () => {
  it('lets a professional with an assignment open an encounter', async () => {
    const patientId = await world.patient([author]);

    expect((await open(author, { patientId, templateKind: 'general' })).statusCode).toBe(201);
  });

  it('lets a professional open another encounter once an earlier one was SIGNED', async () => {
    const patientId = await world.patient();
    await signed(author, patientId);

    const second = await open(author, { patientId, templateKind: 'general' });

    expect(second.statusCode).toBe(201);
  });

  it('lets a brand-new patient (no notes, no anamnesis, no relationship) have a first encounter', async () => {
    const patientId = await world.patient();

    const first = await open(author, { patientId, templateKind: 'general' });

    expect(first.statusCode).toBe(201);
  });

  it('does not count a draft: the relationship appears when the note is signed, not before', async () => {
    const patientId = await world.patient();
    const draft = await world.open(author, patientId);
    expect(await relationship(patientId, author)).toBeUndefined();

    await world.api.put(`/encounters/${draft.encounterId}/note/draft`, author.session, {
      content: { reasonForConsultation: 'Consulta' },
      baseRevision: 0,
    });
    await world.api.post(`/notes/${draft.id}/sign`, author.session, { expectedRevision: 1 });

    expect(await relationship(patientId, author)).toMatchObject({ encounters: 1, active: true });
  });

  it('takes the relationship back only when a SIGNED entry is marked in error', async () => {
    const patientId = await world.patient();
    const note = await signed(author, patientId);
    const drafted = await world.open(author, patientId);
    expect(await relationship(patientId, author)).toMatchObject({ encounters: 1 });

    await world.api.post(`/notes/${drafted.id}/entered-in-error`, author.session, {
      reason: 'Borrador',
    });
    expect(await relationship(patientId, author)).toMatchObject({ encounters: 1, active: true });
    await world.api.post(`/notes/${note.id}/entered-in-error`, author.session, {
      reason: 'Equivocada',
    });

    expect(await relationship(patientId, author)).toMatchObject({ encounters: 0, active: false });
  });
});

describe('the appointment an encounter is opened from', () => {
  // The cases with real appointments (confirmed identity, unconfirmed, somebody else's) are in
  // clinical-appointments.test.ts, which runs the agenda too.
  it('is refused when the appointment does not exist', async () => {
    const patientId = await world.patient([author]);

    const response = await open(author, {
      patientId,
      templateKind: 'general',
      appointmentId: randomUUID(),
    });

    expect(response.statusCode).toBe(403);
    const denials = await asTenant(runtime, world.tenant.id, (tx) =>
      tx
        .select()
        .from(auditEvent)
        .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.patientId, patientId))),
    );
    expect(denials.map((row) => row.reason)).toContain('appointment_mismatch');
  });
});

describe('the database says the same (a backstop under the service)', () => {
  it('refuses an encounter for a patient with a footprint, from a professional with no relationship', async () => {
    const patientId = await world.patient([author]);
    await signed(author, patientId);

    await expect(
      asProfessional(runtime, world.tenant.id, intruder.professionalId, (tx) =>
        openDraft(tx, { tenantId: world.tenant.id, patientId, authorId: intruder.professionalId }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('allows a brand-new patient and a patient the professional treats', async () => {
    const fresh = await world.patient();
    const treated = await world.patient([author]);

    await expect(
      asProfessional(runtime, world.tenant.id, intruder.professionalId, (tx) =>
        openDraft(tx, {
          tenantId: world.tenant.id,
          patientId: fresh,
          authorId: intruder.professionalId,
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
        openDraft(tx, {
          tenantId: world.tenant.id,
          patientId: treated,
          authorId: author.professionalId,
        }),
      ),
    ).resolves.toBeDefined();
  });
});

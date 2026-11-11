import { randomUUID } from 'node:crypto';

import { Problem, type AuditAction, type NoteDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { clinicalNote, encounter, noteVersion } from '../../src/db/schema/clinical.js';
import { contentHash } from '../../src/modules/clinical/domain/canonical.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';
import { asProfessional } from '../support/clinical.js';
import { asTenant } from '../support/tenants.js';

/**
 * Draft and sign (clinical-records, "Encounter notes", "Draft, signing and immutability"), through
 * the real application and a real database as `app_rw`.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let author: Professional;
let colleague: Professional;

const GENERAL = {
  reasonForConsultation: 'Control de presión arterial',
  symptoms: 'Cefalea ocasional',
  diagnosis: 'Hipertensión arterial leve',
  plan: 'Dieta hiposódica',
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createClinicalWorld(runtime, 'clinical-notes');
  author = await world.professional();
  colleague = await world.professional();
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

const saveDraft = (
  note: NoteDto,
  by: Professional,
  content: unknown,
  baseRevision: number,
  extra = {},
) =>
  world.api.put(`/encounters/${note.encounterId}/note/draft`, by.session, {
    content,
    baseRevision,
    ...extra,
  });
const sign = (noteId: string, by: Professional, body: object = { expectedRevision: 1 }) =>
  world.api.post(`/notes/${noteId}/sign`, by.session, body);
const read = (noteId: string, by: Professional) => world.api.get(`/notes/${noteId}`, by.session);

async function auditRows(action: AuditAction, patientId: string) {
  const rows = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === patientId);
}

describe('opening an encounter', () => {
  it('creates a draft for a patient of the organization, with the author taken from the session', async () => {
    const patientId = await world.patient();

    const response = await world.api.post('/encounters', author.session, {
      patientId,
      templateKind: 'general',
      // Neither of these is read from the body.
      authorProfessionalId: colleague.professionalId,
      tenantId: randomUUID(),
    });

    expect(response.statusCode).toBe(201);
    const note = response.json<NoteDto>();
    expect(note).toMatchObject({
      patientId,
      status: 'draft',
      visibility: 'default',
      templateKind: 'general',
      templateVersion: 1,
      draftRevision: 0,
      content: {},
      contentHash: null,
      signedAt: null,
      appointmentId: null,
      author: { professionalId: author.professionalId },
      access: { basis: 'author', canEdit: true, canSign: true },
    });
    expect(Date.parse(note.createdAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('answers as if the patient does not exist for a patient of another organization, and creates nothing', async () => {
    const count = () =>
      asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
        tx.select({ id: encounter.id }).from(encounter),
      ).then((rows) => rows.length);
    await world.open(author, await world.patient());
    const before = await count();
    expect(before).toBeGreaterThan(0);

    const response = await world.api.post('/encounters', author.session, {
      patientId: randomUUID(),
      templateKind: 'general',
    });

    expect(response.statusCode).toBe(404);
    expect(Problem.parse(response.json()).code).toBe('not_found');
    expect(await count()).toBe(before);
  });

  it('makes the author a treating professional and audits the creation without content', async () => {
    const patientId = await world.patient();

    const note = await world.open(author, patientId);
    const rows = await auditRows('clinical.note.created', patientId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'allow',
      resourceType: 'clinical_note',
      resourceId: note.id,
      actorUserId: author.session.user.id,
    });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Control');
    // Treating now: the patient's other entries become readable for the author (care relationship).
    const again = await read(note.id, author);
    expect(again.json<NoteDto>().access.basis).toBe('author');
  });

  it('refuses an unknown template and a body that is not an encounter', async () => {
    const patientId = await world.patient();

    for (const body of [
      { patientId, templateKind: 'astrology' },
      { templateKind: 'general' },
      { patientId: 'nope', templateKind: 'general' },
    ]) {
      const response = await world.api.post('/encounters', author.session, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('saving a draft', () => {
  it('stores the content encrypted and moves the revision forward', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);

    const response = await saveDraft(note, author, GENERAL, 0);

    expect(response.statusCode).toBe(200);
    expect(response.json<NoteDto>()).toMatchObject({ draftRevision: 1, content: GENERAL });
    const [stored] = await asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
      tx.select().from(clinicalNote).where(eq(clinicalNote.id, note.id)),
    );
    const blob = stored?.draftContentEnc?.toString('latin1') ?? '';
    expect(blob.length).toBeGreaterThan(20);
    expect(blob).not.toContain('Hipertens');
    expect(blob).not.toContain('presi');
  });

  it('refuses a save based on an outdated revision and overwrites nothing (two tabs)', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, { ...GENERAL, symptoms: 'Primera pestaña' }, 0);

    const stale = await saveDraft(note, author, { ...GENERAL, symptoms: 'Segunda pestaña' }, 0);

    expect(stale.statusCode).toBe(409);
    expect(Problem.parse(stale.json()).code).toBe('stale_revision');
    const current = (await read(note.id, author)).json<NoteDto>();
    expect(current.content['symptoms']).toBe('Primera pestaña');
    expect(current.draftRevision).toBe(1);
  });

  it('accepts a partial draft but refuses a value that is wrong in itself', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId, { templateKind: 'physiotherapy' });

    expect(
      (await saveDraft(note, author, { affectedRegion: 'Rodilla derecha' }, 0)).statusCode,
    ).toBe(200);
    const bad = await saveDraft(note, author, { painIntensity: 11 }, 1);

    expect(bad.statusCode).toBe(400);
    expect(Problem.parse(bad.json()).errors).toEqual([
      { path: 'painIntensity', i18nKey: 'validation.too_big' },
    ]);
  });

  it('refuses a field the template does not define', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);

    const response = await saveDraft(note, author, { ...GENERAL, authorProfessionalId: 'x' }, 0);

    expect(response.statusCode).toBe(400);
  });

  it('shows the body mass index computed by the server and refuses one sent by the client', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId, { templateKind: 'nutrition' });

    const saved = await saveDraft(note, author, { weightKg: 70, heightM: 1.75 }, 0);
    const forged = await saveDraft(note, author, { weightKg: 70, heightM: 1.75, bmi: 10 }, 1);

    expect(saved.json<NoteDto>().derived).toEqual({ bmi: 22.9 });
    expect(forged.statusCode).toBe(400);
  });

  it('lets the author restrict the entry to themselves while it is a draft', async () => {
    const patientId = await world.patient([author, colleague]);
    const note = await world.open(author, patientId);

    const response = await saveDraft(note, author, GENERAL, 0, { visibility: 'author_only' });

    expect(response.json<NoteDto>().visibility).toBe('author_only');
  });

  it('keeps a draft private to its author: a treating colleague cannot see or change it', async () => {
    const patientId = await world.patient([author, colleague]);
    const note = await world.open(author, patientId);

    expect((await read(note.id, colleague)).statusCode).toBe(404);
    expect((await saveDraft(note, colleague, GENERAL, 0)).statusCode).toBe(404);
    expect((await sign(note.id, colleague)).statusCode).toBe(404);
  });

  it('audits each save as an update, with the revision and no content', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);

    const rows = await auditRows('clinical.note.updated', patientId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ revision: 1, templateKind: 'general' });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Hipertens');
  });
});

describe('signing', () => {
  it('signs a complete draft: signed status, server time and a hash that matches the content', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);

    const response = await sign(note.id, author);

    expect(response.statusCode).toBe(200);
    const signed = response.json<NoteDto>();
    expect(signed).toMatchObject({
      status: 'signed',
      content: GENERAL,
      access: { canEdit: false, canSign: false },
    });
    expect(signed.contentHash).toBe(contentHash(GENERAL));
    expect(Date.parse(signed.signedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    const [version] = await asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
      tx.select().from(noteVersion).where(eq(noteVersion.noteId, note.id)),
    );
    expect(version).toMatchObject({ versionNo: 1, contentHash: contentHash(GENERAL) });
    expect(version?.contentEnc.toString('latin1')).not.toContain('Hipertens');
  });

  it('refuses a second signature', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);
    await sign(note.id, author);

    const again = await sign(note.id, author);

    expect(again.statusCode).toBe(409);
    expect(Problem.parse(again.json()).code).toBe('conflict');
  });

  it('refuses to sign without the required field and names it, leaving the draft as it was', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, { symptoms: 'Tos' }, 0);

    const response = await sign(note.id, author);

    expect(response.statusCode).toBe(400);
    expect(Problem.parse(response.json()).errors).toEqual([
      { path: 'reasonForConsultation', i18nKey: 'validation.required' },
    ]);
    expect((await read(note.id, author)).json<NoteDto>()).toMatchObject({ status: 'draft' });
  });

  it('asks for a follow-up note on a psychology session with high risk', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId, { templateKind: 'psychology' });
    await saveDraft(
      note,
      author,
      { sessionDate: '2026-05-04', modality: 'in_person', risk: 'high', observations: 'Ideación' },
      0,
    );

    const refused = await sign(note.id, author);

    expect(Problem.parse(refused.json()).errors).toEqual([
      { path: 'followUpNote', i18nKey: 'clinical.psychology.follow_up_required' },
    ]);
    await saveDraft(
      note,
      author,
      {
        sessionDate: '2026-05-04',
        modality: 'in_person',
        risk: 'high',
        observations: 'Ideación',
        followUpNote: 'Llamar en 48 horas',
      },
      1,
    );
    expect((await sign(note.id, author, { expectedRevision: 2 })).statusCode).toBe(200);
  });

  it('refuses to sign a revision the author has not seen (a second tab saved in between)', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);

    const stale = await sign(note.id, author, { expectedRevision: 0 });
    const fresh = await sign(note.id, author, { expectedRevision: 1 });

    expect(stale.statusCode).toBe(409);
    expect(Problem.parse(stale.json()).code).toBe('stale_revision');
    expect(fresh.statusCode).toBe(200);
  });

  it('makes the entry immutable: a later edit is refused, audited and changes nothing', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);
    await sign(note.id, author);

    const edit = await saveDraft(note, author, { ...GENERAL, diagnosis: 'Otra cosa' }, 1);
    const restrict = await saveDraft(note, author, GENERAL, 1, { visibility: 'author_only' });

    expect(edit.statusCode).toBe(409);
    expect(restrict.statusCode).toBe(409);
    const unchanged = (await read(note.id, author)).json<NoteDto>();
    expect(unchanged).toMatchObject({ content: GENERAL, visibility: 'default' });
    const denials = await asTenant(runtime, world.tenant.id, (tx) =>
      tx.select().from(auditEvent).where(eq(auditEvent.action, 'access.denied')),
    );
    expect(
      denials.filter((row) => row.patientId === patientId && row.reason === 'note_not_draft'),
    ).toHaveLength(2);
  });

  it('audits the signature with the hash and no content', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);
    await sign(note.id, author);

    const rows = await auditRows('clinical.note.signed', patientId);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      templateKind: 'general',
      versionNo: 1,
      contentHash: contentHash(GENERAL),
    });
    expect(JSON.stringify(rows[0]?.metadata)).not.toContain('Hipertens');
  });

  it('keeps the restriction to the author on a signed entry: a treating colleague cannot read it', async () => {
    const patientId = await world.patient([author, colleague]);
    const note = await world.open(author, patientId, { visibility: 'author_only' });
    await saveDraft(note, author, GENERAL, 0);
    await sign(note.id, author);

    expect((await read(note.id, author)).statusCode).toBe(200);
    expect((await read(note.id, colleague)).statusCode).toBe(404);
  });
});

describe('reading', () => {
  it('shows a signed entry to a colleague who treats the patient, read-only', async () => {
    const patientId = await world.patient([author, colleague]);
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);
    await sign(note.id, author);

    const response = await read(note.id, colleague);

    expect(response.statusCode).toBe(200);
    expect(response.json<NoteDto>()).toMatchObject({
      status: 'signed',
      content: GENERAL,
      access: { basis: 'treating', canEdit: false, canAddAddendum: true },
    });
  });

  it('audits every read with the reader, the patient and the entry', async () => {
    const patientId = await world.patient();
    const note = await world.open(author, patientId);
    await saveDraft(note, author, GENERAL, 0);
    await sign(note.id, author);

    await read(note.id, author);
    await read(note.id, author);
    const rows = await auditRows('clinical.note.read', patientId);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      outcome: 'allow',
      resourceType: 'clinical_note',
      resourceId: note.id,
      actorUserId: author.session.user.id,
      reason: null,
    });
    expect(JSON.stringify(rows)).not.toContain('Hipertens');
  });

  it('answers not found for an entry of another organization or one that does not exist', async () => {
    expect((await read(randomUUID(), author)).statusCode).toBe(404);
    expect((await read('not-a-uuid', author)).statusCode).toBe(400);
  });
});

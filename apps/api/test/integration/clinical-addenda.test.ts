import {
  Problem,
  type AuditAction,
  type HistoryResponse,
  type NoteDto,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { addendum } from '../../src/db/schema/clinical.js';
import { tenant } from '../../src/db/schema/tenant.js';
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
 * Addenda, entries entered in error and the history of an entry (clinical-records, "Addenda and
 * corrections", "Version history", "Retention and availability"), through the real application.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let author: Professional;
let colleague: Professional;
let reader: Professional;

const DIAGNOSIS_A = { reasonForConsultation: 'Control', diagnosis: 'Diagnóstico A' };

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createClinicalWorld(runtime, 'clinical-addenda');
  author = await world.professional();
  colleague = await world.professional();
  reader = await world.professional();
});

beforeEach(async () => {
  await setSettings({});
});

afterAll(async () => {
  await setTenantStatus('active');
  await setSettings({});
  await world.close();
  await runtime.close();
});

async function setTenantStatus(status: 'active' | 'read_only') {
  await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .update(tenant)
      .set({ status, readOnlySince: status === 'read_only' ? new Date() : null })
      .where(eq(tenant.id, world.tenant.id)),
  );
}

async function setSettings(settings: Record<string, unknown>) {
  await asTenant(runtime, world.tenant.id, (tx) =>
    tx.update(tenant).set({ settings }).where(eq(tenant.id, world.tenant.id)),
  );
}

/** A signed general note by `author`, on a patient the colleague also treats. */
async function signedNote(content: object = DIAGNOSIS_A, options: { visibility?: string } = {}) {
  const patientId = await world.patient([author, colleague]);
  const draft = await world.open(author, patientId, options);
  await world.api.put(`/encounters/${draft.encounterId}/note/draft`, author.session, {
    content,
    baseRevision: 0,
  });
  const signed = await world.api.post(`/notes/${draft.id}/sign`, author.session, {
    expectedRevision: 1,
  });
  return { patientId, note: signed.json<NoteDto>() };
}

const addAddendum = (noteId: string, by: Professional, body: object) =>
  world.api.post(`/notes/${noteId}/addenda`, by.session, body);
const markError = (noteId: string, by: Professional, reason: unknown = 'Paciente equivocado') =>
  world.api.post(`/notes/${noteId}/entered-in-error`, by.session, { reason });
const read = (noteId: string, by: Professional) => world.api.get(`/notes/${noteId}`, by.session);

const CORRECTION = {
  kind: 'correction',
  reason: 'Corrección del diagnóstico',
  text: 'El diagnóstico es B',
};

async function rows(action: AuditAction, patientId: string) {
  const found = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return found.filter((row) => row.patientId === patientId);
}

describe('adding an addendum', () => {
  it('keeps the original as it was and shows the addendum after it, with author and time', async () => {
    const { note } = await signedNote();

    const response = await addAddendum(note.id, author, CORRECTION);

    expect(response.statusCode).toBe(201);
    const updated = response.json<NoteDto>();
    expect(updated.content).toEqual(DIAGNOSIS_A);
    expect(updated.contentHash).toBe(contentHash(DIAGNOSIS_A));
    expect(updated.addenda).toHaveLength(1);
    expect(updated.addenda[0]).toMatchObject({
      kind: 'correction',
      reason: 'Corrección del diagnóstico',
      text: 'El diagnóstico es B',
      author: { professionalId: author.professionalId },
    });
    expect(Date.parse(updated.addenda[0]?.createdAt ?? '')).toBeGreaterThan(Date.now() - 60_000);
    expect(updated.status).toBe('signed');
  });

  it('attributes the addendum of another treating professional to them, original untouched', async () => {
    const { note } = await signedNote();

    const response = await addAddendum(note.id, colleague, CORRECTION);

    expect(response.statusCode).toBe(201);
    expect(response.json<NoteDto>().addenda[0]?.author.professionalId).toBe(
      colleague.professionalId,
    );
    expect((await read(note.id, author)).json<NoteDto>().content).toEqual(DIAGNOSIS_A);
  });

  it('lists several addenda in the order they were added', async () => {
    const { note } = await signedNote();
    await addAddendum(note.id, author, { ...CORRECTION, text: 'Primera' });
    await addAddendum(note.id, colleague, { ...CORRECTION, text: 'Segunda' });
    await addAddendum(note.id, author, { ...CORRECTION, text: 'Tercera' });

    const addenda = (await read(note.id, author)).json<NoteDto>().addenda;

    expect(addenda.map((item) => item.text)).toEqual(['Primera', 'Segunda', 'Tercera']);
  });

  it('stores the text encrypted and audits the addendum without it', async () => {
    const { note, patientId } = await signedNote();
    await addAddendum(note.id, colleague, CORRECTION);

    const stored = await asProfessional(runtime, world.tenant.id, colleague.professionalId, (tx) =>
      tx.select().from(addendum).where(eq(addendum.noteId, note.id)),
    );
    const audit = await rows('clinical.note.amended', patientId);

    expect(stored[0]?.contentEnc.toString('latin1')).not.toContain('diagnóstico');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      outcome: 'allow',
      actorUserId: colleague.session.user.id,
      resourceId: note.id,
    });
    expect(audit[0]?.metadata).toMatchObject({ kind: 'correction' });
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain('B');
  });

  it('requires a reason (and a text, and a known kind)', async () => {
    const { note } = await signedNote();

    for (const body of [
      { ...CORRECTION, reason: '' },
      { ...CORRECTION, reason: '   ' },
      { kind: 'correction', text: 'Sin motivo' },
      { ...CORRECTION, text: '' },
      { ...CORRECTION, kind: 'opinion' },
    ]) {
      const response = await addAddendum(note.id, author, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await read(note.id, author)).json<NoteDto>().addenda).toEqual([]);
  });

  it('is refused on a draft and on an entry marked in error, and audited', async () => {
    const patientId = await world.patient();
    const draft = await world.open(author, patientId);
    const { note: wrong, patientId: wrongPatient } = await signedNote();
    await markError(wrong.id, author);

    const onDraft = await addAddendum(draft.id, author, CORRECTION);
    const onError = await addAddendum(wrong.id, author, CORRECTION);

    expect(onDraft.statusCode).toBe(409);
    expect(onError.statusCode).toBe(409);
    const denials = await rows('access.denied', wrongPatient);
    expect(denials.some((row) => row.reason === 'note_not_signed')).toBe(true);
  });

  it('is refused for a professional who reads the entry only through sharing, and audited', async () => {
    const { note, patientId } = await signedNote();
    await setSettings({ clinicalSharing: true, sharedTemplates: ['general'] });

    const response = await addAddendum(note.id, reader, CORRECTION);

    expect(response.statusCode).toBe(403);
    expect(Problem.parse(response.json()).code).toBe('forbidden');
    const denials = await rows('access.denied', patientId);
    expect(denials[0]).toMatchObject({
      outcome: 'deny',
      actorUserId: reader.session.user.id,
      reason: 'addendum_not_treating',
    });
    expect((await read(note.id, author)).json<NoteDto>().addenda).toEqual([]);
  });
});

describe('a shared read', () => {
  it('shows the entry read-only to a professional who does not treat the patient, audited as shared', async () => {
    const { note, patientId } = await signedNote();
    await setSettings({ clinicalSharing: true, sharedTemplates: ['general'] });

    const response = await read(note.id, reader);

    expect(response.statusCode).toBe(200);
    expect(response.json<NoteDto>()).toMatchObject({
      content: DIAGNOSIS_A,
      access: {
        basis: 'shared',
        canEdit: false,
        canAddAddendum: false,
        canMarkError: false,
      },
    });
    const audit = await rows('clinical.note.read', patientId);
    expect(audit[0]).toMatchObject({
      outcome: 'allow',
      actorUserId: reader.session.user.id,
      reason: 'shared',
      resourceId: note.id,
    });
  });

  it('does not mark a read as shared when the reader treats the patient, and does not show psychology', async () => {
    const { note, patientId } = await signedNote();
    await setSettings({ clinicalSharing: true, sharedTemplates: ['general'] });
    await read(note.id, colleague);

    const audit = await rows('clinical.note.read', patientId);

    expect(audit[0]?.reason).toBeNull();

    const psychology = await world.patient([author, colleague]);
    const draft = await world.open(author, psychology, { templateKind: 'psychology' });
    await world.api.put(`/encounters/${draft.encounterId}/note/draft`, author.session, {
      content: { sessionDate: '2026-05-04', modality: 'in_person', risk: 'none' },
      baseRevision: 0,
    });
    await world.api.post(`/notes/${draft.id}/sign`, author.session, { expectedRevision: 1 });
    expect((await read(draft.id, reader)).statusCode).toBe(404);
    expect((await read(draft.id, colleague)).statusCode).toBe(200);
  });
});

describe('entered in error', () => {
  it('lets the author mark a signed entry: the content is kept and readable, with the reason and who', async () => {
    const { note, patientId } = await signedNote();

    const response = await markError(note.id, author, 'Paciente equivocado');

    expect(response.statusCode).toBe(200);
    const marked = response.json<NoteDto>();
    expect(marked.status).toBe('entered_in_error');
    expect(marked.content).toEqual(DIAGNOSIS_A);
    expect(marked.error).toMatchObject({
      reason: 'Paciente equivocado',
      markedBy: { professionalId: author.professionalId },
    });
    expect(marked.access).toMatchObject({ canAddAddendum: false, canMarkError: false });
    expect((await read(note.id, colleague)).json<NoteDto>().content).toEqual(DIAGNOSIS_A);
    const audit = await rows('clinical.note.entered_in_error', patientId);
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]?.metadata)).not.toContain('equivocado');
  });

  it('lets another treating professional mark it, recording that professional', async () => {
    const { note } = await signedNote();

    const response = await markError(note.id, colleague, 'Duplicado');

    expect(response.statusCode).toBe(200);
    expect(response.json<NoteDto>().error?.markedBy.professionalId).toBe(colleague.professionalId);
  });

  it('refuses a professional who only reads it through sharing, and audits the attempt', async () => {
    const { note, patientId } = await signedNote();
    await setSettings({ clinicalSharing: true, sharedTemplates: ['general'] });

    const response = await markError(note.id, reader);

    expect(response.statusCode).toBe(403);
    expect((await rows('access.denied', patientId))[0]).toMatchObject({
      reason: 'error_not_allowed',
      actorUserId: reader.session.user.id,
    });
    expect((await read(note.id, author)).json<NoteDto>().status).toBe('signed');
  });

  it('requires a reason and cannot be done twice', async () => {
    const { note } = await signedNote();

    expect((await markError(note.id, author, '')).statusCode).toBe(400);
    expect((await markError(note.id, author, '   ')).statusCode).toBe(400);
    expect((await markError(note.id, author)).statusCode).toBe(200);
    expect((await markError(note.id, author, 'Otra vez')).statusCode).toBe(409);
  });

  it('lets the author mark an unsigned draft opened on the wrong patient', async () => {
    const patientId = await world.patient();
    const draft = await world.open(author, patientId);

    const response = await markError(draft.id, author, 'Abierta en otro paciente');
    const otherDraft = await world.open(author, await world.patient());
    const refused = await markError(otherDraft.id, colleague);

    expect(response.statusCode).toBe(200);
    expect(response.json<NoteDto>().status).toBe('entered_in_error');
    expect(refused.statusCode).toBe(404);
  });
});

describe('the history of an entry', () => {
  it('lists the signed version with its hash, then the addenda and the error mark, in order', async () => {
    const { note } = await signedNote();
    await addAddendum(note.id, colleague, { ...CORRECTION, text: 'Primera' });
    await addAddendum(note.id, author, { ...CORRECTION, text: 'Segunda' });
    await markError(note.id, author, 'Duplicado');

    const response = await world.api.get(`/notes/${note.id}/versions`, colleague.session);

    expect(response.statusCode).toBe(200);
    const history = response.json<HistoryResponse>();
    expect(history.noteId).toBe(note.id);
    expect(history.items.map((item) => item.type)).toEqual([
      'version',
      'addendum',
      'addendum',
      'entered_in_error',
    ]);
    expect(history.items[0]).toMatchObject({
      type: 'version',
      versionNo: 1,
      contentHash: contentHash(DIAGNOSIS_A),
      author: { professionalId: author.professionalId },
    });
    expect(history.items[1]).toMatchObject({
      type: 'addendum',
      author: { professionalId: colleague.professionalId },
    });
    const times = history.items.map((item) => Date.parse(item.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const hashes = history.items.flatMap((item) =>
      'contentHash' in item ? [item.contentHash] : [],
    );
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  it('audits the reading of the history, and cannot be purged by anybody', async () => {
    const { note, patientId } = await signedNote();

    await world.api.get(`/notes/${note.id}/versions`, author.session);
    const audit = await rows('clinical.note.read', patientId);
    const purge = await world.api.delete(`/notes/${note.id}/versions`, author.session);
    const owner = await world.api.delete(`/notes/${note.id}`, world.owner);

    expect(audit[0]?.metadata).toMatchObject({ via: 'history' });
    expect([purge.statusCode, owner.statusCode]).toEqual([404, 404]);
    const left = await asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM note_version WHERE note_id = ${note.id}`,
      ),
    );
    expect(left.rows[0]?.n).toBe(1);
  });
});

describe('a read-only organization (D16)', () => {
  it('keeps reading, adds a rectification addendum, and refuses every other clinical write', async () => {
    const { note, patientId } = await signedNote();
    const draftPatient = await world.patient();
    const draft = await world.open(author, draftPatient);
    await setTenantStatus('read_only');
    try {
      const readIt = await read(note.id, author);
      const rectification = await addAddendum(note.id, colleague, {
        kind: 'rectification',
        reason: 'Pedido de rectificación del paciente',
        text: 'La alergia registrada es a la dipirona',
      });
      const correction = await addAddendum(note.id, author, CORRECTION);
      const newEncounter = await world.api.post('/encounters', author.session, {
        patientId,
        templateKind: 'general',
      });
      const saveDraft = await world.api.put(
        `/encounters/${draft.encounterId}/note/draft`,
        author.session,
        { content: { symptoms: 'Tos' }, baseRevision: 0 },
      );
      const signDraft = await world.api.post(`/notes/${draft.id}/sign`, author.session, {
        expectedRevision: 1,
      });
      const error = await markError(note.id, author);

      expect(readIt.statusCode).toBe(200);
      expect(readIt.json<NoteDto>().access).toMatchObject({
        rectificationOnly: true,
        canAddAddendum: true,
        canEdit: false,
        canMarkError: false,
      });
      expect(rectification.statusCode).toBe(201);
      expect(rectification.json<NoteDto>().addenda[0]).toMatchObject({ kind: 'rectification' });
      for (const refused of [correction, newEncounter, saveDraft, signDraft, error]) {
        expect(refused.statusCode).toBe(402);
        expect(Problem.parse(refused.json()).code).toBe('tenant_read_only');
      }
      const audit = await rows('clinical.note.amended', patientId);
      expect(audit).toHaveLength(1);
      expect(audit[0]?.metadata).toMatchObject({ kind: 'rectification' });
    } finally {
      await setTenantStatus('active');
    }
  });

  it('still refuses a rectification addendum from a professional who does not treat the patient', async () => {
    const { note } = await signedNote();
    await setTenantStatus('read_only');
    try {
      const response = await addAddendum(note.id, reader, {
        kind: 'rectification',
        reason: 'Pedido del paciente',
        text: 'Texto',
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await setTenantStatus('active');
    }
  });
});

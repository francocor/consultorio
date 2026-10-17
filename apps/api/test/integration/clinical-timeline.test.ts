import {
  EMPTY_ANAMNESIS,
  Problem,
  type AuditAction,
  type CurrentOdontogramResponse,
  type DraftsResponse,
  type NoteDto,
  type TimelineResponse,
} from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';
import { asTenant } from '../support/tenants.js';

/**
 * The clinical timeline of a patient (clinical-records, "Patient clinical timeline and anamnesis
 * link"), the professional's drafts and the current odontogram.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let author: Professional;
let colleague: Professional;
let stranger: Professional;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createClinicalWorld(runtime, 'clinical-timeline');
  author = await world.professional();
  colleague = await world.professional();
  stranger = await world.professional();
});

beforeEach(async () => {
  await asTenant(runtime, world.tenant.id, (tx) =>
    tx.update(tenant).set({ settings: {} }).where(eq(tenant.id, world.tenant.id)),
  );
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** Opens, fills and signs a note; returns it as signed. */
async function signed(
  by: Professional,
  patientId: string,
  content: object = { reasonForConsultation: 'Control' },
  options: { templateKind?: string; visibility?: string } = {},
): Promise<NoteDto> {
  const draft = await world.open(by, patientId, options);
  await world.api.put(`/encounters/${draft.encounterId}/note/draft`, by.session, {
    content,
    baseRevision: 0,
  });
  const response = await world.api.post(`/notes/${draft.id}/sign`, by.session, {
    expectedRevision: 1,
  });
  if (response.statusCode !== 200)
    throw new Error(`could not sign: ${String(response.statusCode)}`);
  return response.json<NoteDto>();
}

const timeline = (patientId: string, by: Professional, query = '') =>
  world.api.get(`/patients/${patientId}/clinical/timeline${query}`, by.session);

async function rows(action: AuditAction, patientId: string) {
  const found = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, world.tenant.id), eq(auditEvent.action, action))),
  );
  return found.filter((row) => row.patientId === patientId);
}

describe('the timeline of a patient', () => {
  it('lists the signed entries newest first, with their addenda attached and a headline', async () => {
    const patientId = await world.patient([author, colleague]);
    const first = await signed(author, patientId, { reasonForConsultation: 'Primera consulta' });
    const second = await signed(colleague, patientId, {
      reasonForConsultation: 'Segunda consulta',
    });
    const third = await signed(author, patientId, { reasonForConsultation: 'Tercera consulta' });
    await world.api.post(`/notes/${first.id}/addenda`, colleague.session, {
      kind: 'correction',
      reason: 'Motivo',
      text: 'Se precisa la fecha',
    });

    const response = await timeline(patientId, author);

    expect(response.statusCode).toBe(200);
    const body = response.json<TimelineResponse>();
    expect(body.entries.map((entry) => entry.noteId)).toEqual([third.id, second.id, first.id]);
    expect(body.entries.map((entry) => entry.headline)).toEqual([
      'Tercera consulta',
      'Segunda consulta',
      'Primera consulta',
    ]);
    expect(body.entries[2]?.addenda).toHaveLength(1);
    expect(body.entries[2]?.addenda[0]).toMatchObject({ text: 'Se precisa la fecha' });
    expect(body.entries[0]).toMatchObject({
      status: 'signed',
      templateKind: 'general',
      basis: 'author',
      author: { professionalId: author.professionalId },
    });
    expect(body.nextCursor).toBeNull();
  });

  it('leaves out drafts and, unless asked, the entries marked in error', async () => {
    const patientId = await world.patient();
    const kept = await signed(author, patientId, { reasonForConsultation: 'Valida' });
    const wrong = await signed(author, patientId, { reasonForConsultation: 'Equivocada' });
    await world.open(author, patientId);
    await world.api.post(`/notes/${wrong.id}/entered-in-error`, author.session, {
      reason: 'Paciente equivocado',
    });

    const normal = (await timeline(patientId, author)).json<TimelineResponse>();
    const withErrors = (
      await timeline(patientId, author, '?includeErrors=true')
    ).json<TimelineResponse>();

    expect(normal.entries.map((entry) => entry.noteId)).toEqual([kept.id]);
    expect(withErrors.entries.map((entry) => entry.noteId)).toEqual([wrong.id, kept.id]);
    expect(withErrors.entries[0]).toMatchObject({
      status: 'entered_in_error',
      errorReason: 'Paciente equivocado',
    });
  });

  it('shows only the entries the reader may read, and counts nothing it hides', async () => {
    const patientId = await world.patient([author, colleague]);
    const visible = await signed(author, patientId, { reasonForConsultation: 'Visible' });
    await signed(
      author,
      patientId,
      { reasonForConsultation: 'Reservada' },
      { visibility: 'author_only' },
    );
    const psychology = await signed(
      author,
      patientId,
      { sessionDate: '2026-05-04', modality: 'in_person', risk: 'none' },
      { templateKind: 'psychology' },
    );

    const asColleague = (await timeline(patientId, colleague)).json<TimelineResponse>();
    const asAuthor = (await timeline(patientId, author)).json<TimelineResponse>();

    // The colleague treats the patient, so the psychology note is theirs to read; the restricted one is not.
    expect(asColleague.entries.map((entry) => entry.noteId).sort()).toEqual(
      [visible.id, psychology.id].sort(),
    );
    expect(asAuthor.entries).toHaveLength(3);
    expect(JSON.stringify(asColleague)).not.toContain('Reservada');
  });

  it('shows a shared reader the shared scope only, marked and audited as shared', async () => {
    const patientId = await world.patient();
    const general = await signed(author, patientId, { reasonForConsultation: 'General' });
    await signed(
      author,
      patientId,
      { sessionDate: '2026-05-04', modality: 'in_person', risk: 'none' },
      { templateKind: 'psychology' },
    );
    await world.api.patch('/settings', world.owner, { clinicalSharing: true });

    const response = await timeline(patientId, stranger);

    expect(response.statusCode).toBe(200);
    const body = response.json<TimelineResponse>();
    expect(body.entries.map((entry) => entry.noteId)).toEqual([general.id]);
    expect(body.entries[0]?.basis).toBe('shared');
    const audit = await rows('clinical.note.read', patientId);
    const forStranger = audit.filter((row) => row.actorUserId === stranger.session.user.id);
    expect(forStranger).toHaveLength(1);
    expect(forStranger[0]).toMatchObject({ reason: 'shared', resourceId: general.id });
    expect(forStranger[0]?.metadata).toMatchObject({ via: 'timeline' });
  });

  it('writes one audited read per entry shown, with no content', async () => {
    const patientId = await world.patient();
    await signed(author, patientId, { reasonForConsultation: 'Confidencial uno' });
    await signed(author, patientId, { reasonForConsultation: 'Confidencial dos' });

    await timeline(patientId, author);
    const audit = (await rows('clinical.note.read', patientId)).filter(
      (row) => (row.metadata as { via?: string }).via === 'timeline',
    );

    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('Confidencial');
  });

  it('links to the anamnesis without repeating it', async () => {
    const patientId = await world.patient([author]);
    const without = (await timeline(patientId, author)).json<TimelineResponse>();
    await world.api.put(`/patients/${patientId}/anamnesis`, author.session, {
      content: { ...EMPTY_ANAMNESIS, antecedents: 'Antecedente reservado' },
      expectedVersion: 0,
    });

    const response = await timeline(patientId, author);

    expect(without.anamnesis).toBeNull();
    expect(response.json<TimelineResponse>().anamnesis).toEqual({ version: 1 });
    expect(response.body).not.toContain('Antecedente reservado');
  });

  it('pages with a cursor', async () => {
    const patientId = await world.patient();
    const notes: NoteDto[] = [];
    for (const reason of ['Uno', 'Dos', 'Tres']) {
      notes.push(await signed(author, patientId, { reasonForConsultation: reason }));
    }

    const page1 = (await timeline(patientId, author, '?limit=2')).json<TimelineResponse>();
    const page2 = (
      await timeline(patientId, author, `?limit=2&before=${page1.nextCursor ?? ''}`)
    ).json<TimelineResponse>();

    expect(page1.entries.map((entry) => entry.headline)).toEqual(['Tres', 'Dos']);
    expect(page1.nextCursor).toBe(notes[1]?.id);
    expect(page2.entries.map((entry) => entry.headline)).toEqual(['Uno']);
    expect(page2.nextCursor).toBeNull();
  });

  it('refuses a professional with no relationship and nothing to read, and audits the denial', async () => {
    const patientId = await world.patient();
    await signed(author, patientId);

    const response = await timeline(patientId, stranger);

    expect(response.statusCode).toBe(403);
    expect(Problem.parse(response.json()).code).toBe('forbidden');
    const denials = await rows('access.denied', patientId);
    expect(denials[0]).toMatchObject({
      outcome: 'deny',
      actorUserId: stranger.session.user.id,
      reason: 'timeline_not_readable',
    });
  });

  it('tells a treating professional of an empty record that there is nothing yet, and 404s an unknown patient', async () => {
    const patientId = await world.patient([author, colleague]);

    const empty = await timeline(patientId, colleague);
    const missing = await timeline('0190a000-0000-7000-8000-0000000000aa', colleague);

    expect(empty.json<TimelineResponse>().entries).toEqual([]);
    expect(missing.statusCode).toBe(404);
  });
});

describe('the drafts of a professional', () => {
  it('lists the own drafts with the patient, newest first, and no draft of a colleague', async () => {
    const patientId = await world.patient([author]);
    const mine = await world.open(author, patientId);
    await world.open(colleague, await world.patient());
    await signed(author, patientId);

    const response = await world.api.get('/clinical/drafts', author.session);

    expect(response.statusCode).toBe(200);
    const drafts = response.json<DraftsResponse>().drafts;
    expect(drafts.map((draft) => draft.noteId)).toContain(mine.id);
    expect(drafts.every((draft) => draft.patientName.length > 0)).toBe(true);
    const others = await world.api.get('/clinical/drafts', colleague.session);
    expect(others.json<DraftsResponse>().drafts.map((draft) => draft.noteId)).not.toContain(
      mine.id,
    );
  });
});

describe('the current odontogram', () => {
  it('derives the chart from the signed entries without overwriting an earlier one', async () => {
    const patientId = await world.patient();
    const dentist = await world.professional(['Odontología']);
    const first = await signed(
      dentist,
      patientId,
      {
        reasonForConsultation: 'Dolor',
        odontogram: { '16': { condition: 'caries' }, '26': { condition: 'healthy' } },
      },
      { templateKind: 'odontology' },
    );
    await signed(
      dentist,
      patientId,
      { reasonForConsultation: 'Control', odontogram: { '16': { condition: 'restoration' } } },
      { templateKind: 'odontology' },
    );

    const response = await world.api.get(
      `/patients/${patientId}/clinical/odontogram`,
      dentist.session,
    );

    expect(response.statusCode).toBe(200);
    const chart = response.json<CurrentOdontogramResponse>();
    expect(chart.entries).toBe(2);
    expect(chart.teeth['16']).toMatchObject({ condition: 'restoration' });
    expect(chart.teeth['26']).toMatchObject({ condition: 'healthy' });
    const earlier = await world.api.get(`/notes/${first.id}`, dentist.session);
    expect(earlier.json<NoteDto>().content['odontogram']).toMatchObject({
      '16': { condition: 'caries' },
    });
  });
});

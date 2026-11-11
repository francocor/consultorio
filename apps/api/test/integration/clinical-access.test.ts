import { randomUUID } from 'node:crypto';

import { Problem, type NoteDto } from '@consultorio/contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { addendum, clinicalNote, encounter, noteVersion } from '../../src/db/schema/clinical.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';
import { asProfessional } from '../support/clinical.js';
import type { TestSession } from '../support/session.js';
import { asTenant } from '../support/tenants.js';

/**
 * Who reaches clinical content (clinical-records, "Clinical access restriction"; authorization,
 * "Clinical notes readable by health professionals only"). The same note is requested by every
 * kind of user the product has, and the answer and the audit trail are checked for each.
 */
let runtime: DbHandle;
let world: ClinicalWorld;
let author: Professional;
let stranger: Professional;
let note: NoteDto;
let patientId: string;

const GENERAL = {
  reasonForConsultation: 'Control',
  diagnosis: 'Diagnóstico confidencial del paciente',
};

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  world = await createClinicalWorld(runtime, 'clinical-access');
  author = await world.professional();
  stranger = await world.professional();
  patientId = await world.patient();
  const draft = await world.open(author, patientId);
  await world.api.put(`/encounters/${draft.encounterId}/note/draft`, author.session, {
    content: GENERAL,
    baseRevision: 0,
  });
  await world.api.post(`/notes/${draft.id}/sign`, author.session, { expectedRevision: 1 });
  note = draft;
});

afterAll(async () => {
  await world.close();
  await runtime.close();
});

/** Every clinical route a note has, with the request that reaches its handler. */
function routes(noteId: string, encounterId: string, forPatient: string) {
  return [
    { method: 'GET', url: `/notes/${noteId}` },
    {
      method: 'POST',
      url: `/encounters`,
      payload: { patientId: forPatient, templateKind: 'general' },
    },
    {
      method: 'PUT',
      url: `/encounters/${encounterId}/note/draft`,
      payload: { content: {}, baseRevision: 0 },
    },
    { method: 'POST', url: `/notes/${noteId}/sign`, payload: { expectedRevision: 1 } },
    { method: 'GET', url: `/notes/${noteId}/versions` },
    {
      method: 'POST',
      url: `/notes/${noteId}/addenda`,
      payload: { kind: 'correction', reason: 'Motivo', text: 'Texto' },
    },
    { method: 'POST', url: `/notes/${noteId}/entered-in-error`, payload: { reason: 'Motivo' } },
    { method: 'GET', url: `/patients/${forPatient}/clinical/timeline` },
    { method: 'GET', url: `/patients/${forPatient}/clinical/search?q=confidencial` },
    { method: 'GET', url: `/patients/${forPatient}/clinical/odontogram` },
    { method: 'GET', url: '/clinical/drafts' },
    { method: 'GET', url: '/clinical/templates' },
  ] as const;
}

async function send(session: TestSession, route: ReturnType<typeof routes>[number]) {
  const payload = 'payload' in route ? route.payload : undefined;
  switch (route.method) {
    case 'GET':
      return world.api.get(route.url, session);
    case 'PUT':
      return world.api.put(route.url, session, payload);
    default:
      return world.api.post(route.url, session, payload);
  }
}

async function denialsFor(userId: string) {
  const rows = await asTenant(runtime, world.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.action, 'access.denied'), eq(auditEvent.actorUserId, userId))),
  );
  return rows;
}

describe('owner, admin and reception never reach clinical content', () => {
  for (const [label, pick] of [
    ['owner', () => world.owner],
    ['admin', () => world.admin],
    ['reception', () => world.reception],
  ] as const) {
    it(`${label}: 403 on every clinical route, no content in the body, one deny audit row each`, async () => {
      const session = pick();
      const list = routes(note.id, note.encounterId, patientId);
      const before = (await denialsFor(session.user.id)).length;

      for (const route of list) {
        const response = await send(session, route);

        expect(response.statusCode, `${label} ${route.method} ${route.url}`).toBe(403);
        expect(response.body).not.toContain('confidencial');
        expect(response.body).not.toContain('Control');
        expect(Problem.parse(response.json()).code).toBe('forbidden');
      }
      const after = await denialsFor(session.user.id);
      expect(after.length - before).toBe(list.length);
      expect(after.every((row) => row.outcome === 'deny' && row.resourceType === 'route')).toBe(
        true,
      );
    });
  }
});

describe('the database refuses even when the application would not', () => {
  it('returns zero rows of every clinical table to a transaction that is not a professional', async () => {
    const rows = await asTenant(runtime, world.tenant.id, async (tx) => ({
      encounters: await tx.select({ id: encounter.id }).from(encounter),
      notes: await tx.select({ id: clinicalNote.id }).from(clinicalNote),
      versions: await tx.select({ id: noteVersion.id }).from(noteVersion),
      addenda: await tx.select({ id: addendum.id }).from(addendum),
    }));

    expect(rows).toEqual({ encounters: [], notes: [], versions: [], addenda: [] });
    // The data is really there: the author sees it.
    const own = await asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
      tx.select({ id: clinicalNote.id }).from(clinicalNote).where(eq(clinicalNote.id, note.id)),
    );
    expect(own).toHaveLength(1);
  });

  it('returns zero rows to a professional with no relationship to the patient (sharing off)', async () => {
    const rows = await asProfessional(
      runtime,
      world.tenant.id,
      stranger.professionalId,
      async (tx) => ({
        notes: await tx
          .select({ id: clinicalNote.id })
          .from(clinicalNote)
          .where(eq(clinicalNote.id, note.id)),
        versions: await tx
          .select({ id: noteVersion.id })
          .from(noteVersion)
          .where(eq(noteVersion.noteId, note.id)),
      }),
    );

    expect(rows).toEqual({ notes: [], versions: [] });
  });
});

describe('a professional with no relationship to the patient', () => {
  it('cannot read the entry (not found, as for an entry that does not exist)', async () => {
    const response = await world.api.get(`/notes/${note.id}`, stranger.session);
    const missing = await world.api.get(`/notes/${randomUUID()}`, stranger.session);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
    expect({ ...response.json<object>(), requestId: '' }).toEqual({
      ...missing.json<object>(),
      requestId: '',
    });
  });

  it('cannot sign, edit, annotate, mark or list the history of the entry', async () => {
    const attempts = [
      world.api.post(`/notes/${note.id}/sign`, stranger.session, { expectedRevision: 1 }),
      world.api.put(`/encounters/${note.encounterId}/note/draft`, stranger.session, {
        content: {},
        baseRevision: 0,
      }),
      world.api.post(`/notes/${note.id}/addenda`, stranger.session, {
        kind: 'correction',
        reason: 'Motivo',
        text: 'Texto',
      }),
      world.api.post(`/notes/${note.id}/entered-in-error`, stranger.session, { reason: 'Motivo' }),
      world.api.get(`/notes/${note.id}/versions`, stranger.session),
    ];

    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode).toBe(404);
    }
  });
});

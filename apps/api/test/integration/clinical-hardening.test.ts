import { Problem, type NoteDto } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { addendum, clinicalNote } from '../../src/db/schema/clinical.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import {
  createClinicalWorld,
  type ClinicalWorld,
  type Professional,
} from '../support/clinical-world.js';
import { asProfessional } from '../support/clinical.js';

/**
 * Findings of the security review of the clinical track: an entry marked in error must not leave its
 * working copy readable (M1), the reasons are encrypted like the content (M2), signing always names
 * the revision the author saw (L1) and the per-record search is rate limited per user (L2).
 */
let runtime: DbHandle;
let owner: pg.Client;
let world: ClinicalWorld;
let author: Professional;
let colleague: Professional;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  world = await createClinicalWorld(runtime, 'clinical-hardening', {
    clinical: { searchRateLimit: { max: 2, windowMs: 60_000 } },
  });
  author = await world.professional();
  colleague = await world.professional();
});

afterAll(async () => {
  await world.close();
  await owner.end();
  await runtime.close();
});

const SECRET = 'TEXTOSECRETO-del-borrador';

async function draftWithText(patientId: string): Promise<NoteDto> {
  const draft = await world.open(author, patientId);
  const saved = await world.api.put(`/encounters/${draft.encounterId}/note/draft`, author.session, {
    content: { reasonForConsultation: SECRET },
    baseRevision: 0,
  });
  expect(saved.statusCode).toBe(200);
  return saved.json<NoteDto>();
}

describe('M1: a draft marked in error does not stay readable by others', () => {
  it('drops its working copy, so a treating colleague reads nothing of it', async () => {
    const patientId = await world.patient([author, colleague]);
    const draft = await draftWithText(patientId);

    const marked = await world.api.post(`/notes/${draft.id}/entered-in-error`, author.session, {
      reason: 'Abierta en otro paciente',
    });

    expect(marked.statusCode).toBe(200);
    expect(marked.json<NoteDto>().content).toEqual({});
    const asColleague = await world.api.get(`/notes/${draft.id}`, colleague.session);
    expect(asColleague.statusCode).toBe(200);
    expect(asColleague.json<NoteDto>()).toMatchObject({ status: 'entered_in_error', content: {} });
    expect(asColleague.body).not.toContain(SECRET);
    const [row] = await asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
      tx.select().from(clinicalNote).where(eq(clinicalNote.id, draft.id)),
    );
    expect(row?.draftContentEnc).toBeNull();
    const timeline = await world.api.get(
      `/patients/${patientId}/clinical/timeline?includeErrors=true`,
      colleague.session,
    );
    expect(timeline.body).not.toContain(SECRET);
  });

  it('is enforced by the database: an in-error draft that kept its content is refused', async () => {
    const patientId = await world.patient([author]);
    const draft = await draftWithText(patientId);

    await expect(
      asProfessional(runtime, world.tenant.id, author.professionalId, (tx) =>
        tx.execute(
          sql`UPDATE clinical_note SET status = 'entered_in_error', error_reason_enc = ${Buffer.from([1])} WHERE id = ${draft.id}`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: expect.stringMatching(/^23(000|514)$/) as unknown } });
  });

  it('keeps the content of a SIGNED entry marked in error (only a draft loses its copy)', async () => {
    const patientId = await world.patient([author]);
    const draft = await draftWithText(patientId);
    await world.api.post(`/notes/${draft.id}/sign`, author.session, { expectedRevision: 1 });

    const marked = await world.api.post(`/notes/${draft.id}/entered-in-error`, author.session, {
      reason: 'Duplicada',
    });

    expect(marked.json<NoteDto>().content).toEqual({ reasonForConsultation: SECRET });
  });
});

describe('M2: reasons are encrypted like the content', () => {
  it('has no plaintext reason column left', async () => {
    const result = await owner.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('addendum', 'clinical_note') AND column_name IN ('reason', 'error_reason')`,
    );

    expect(result.rows).toEqual([]);
  });

  it('stores the reason of an addendum and of an error mark as ciphertext, and returns them in clear', async () => {
    const patientId = await world.patient([author]);
    const draft = await draftWithText(patientId);
    await world.api.post(`/notes/${draft.id}/sign`, author.session, { expectedRevision: 1 });

    const withAddendum = await world.api.post(`/notes/${draft.id}/addenda`, author.session, {
      kind: 'correction',
      reason: 'MOTIVOSECRETO-adenda',
      text: 'Texto de la adenda',
    });
    const marked = await world.api.post(`/notes/${draft.id}/entered-in-error`, author.session, {
      reason: 'MOTIVOSECRETO-error',
    });

    expect(withAddendum.json<NoteDto>().addenda[0]?.reason).toBe('MOTIVOSECRETO-adenda');
    expect(marked.json<NoteDto>().error?.reason).toBe('MOTIVOSECRETO-error');
    const stored = await asProfessional(
      runtime,
      world.tenant.id,
      author.professionalId,
      async (tx) => ({
        addenda: await tx.select().from(addendum).where(eq(addendum.noteId, draft.id)),
        note: await tx.select().from(clinicalNote).where(eq(clinicalNote.id, draft.id)),
      }),
    );
    expect(stored.addenda[0]?.reasonEnc.toString('latin1')).not.toContain('MOTIVOSECRETO');
    expect(stored.note[0]?.errorReasonEnc?.toString('latin1')).not.toContain('MOTIVOSECRETO');
    // The history and the timeline read them back too.
    const history = await world.api.get(`/notes/${draft.id}/versions`, author.session);
    expect(history.body).toContain('MOTIVOSECRETO-adenda');
    expect(history.body).toContain('MOTIVOSECRETO-error');
  });

  it('still requires a reason (the contract), now that the database cannot read it', async () => {
    const patientId = await world.patient([author]);
    const draft = await draftWithText(patientId);
    await world.api.post(`/notes/${draft.id}/sign`, author.session, { expectedRevision: 1 });

    const response = await world.api.post(`/notes/${draft.id}/addenda`, author.session, {
      kind: 'correction',
      reason: '   ',
      text: 'Texto',
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('L1: signing always names the revision the author saw', () => {
  it('refuses a signature with no expectedRevision, and leaves the draft as it was', async () => {
    const patientId = await world.patient([author]);
    const draft = await draftWithText(patientId);

    const without = await world.api.post(`/notes/${draft.id}/sign`, author.session, {});
    const wrong = await world.api.post(`/notes/${draft.id}/sign`, author.session, {
      expectedRevision: 0,
    });

    expect(without.statusCode).toBe(400);
    expect(wrong.statusCode).toBe(409);
    expect(Problem.parse(wrong.json()).code).toBe('stale_revision');
    expect((await world.api.get(`/notes/${draft.id}`, author.session)).json<NoteDto>().status).toBe(
      'draft',
    );
    const ok = await world.api.post(`/notes/${draft.id}/sign`, author.session, {
      expectedRevision: 1,
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('L2: the per-record search is rate limited per user', () => {
  it('answers 429 with Retry-After after the allowance, counted per user and not per address', async () => {
    const patientId = await world.patient([author, colleague]);
    const search = (by: Professional) =>
      world.api.get(`/patients/${patientId}/clinical/search?q=consulta`, by.session);

    const first = await search(author);
    const second = await search(author);
    const third = await search(author);
    const other = await search(colleague);

    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    expect(Problem.parse(third.json()).code).toBe('rate_limited');
    // Everybody in the test shares one address: a second user is not held back by the first.
    expect(other.statusCode).toBe(200);
  });

  it('does not count the other clinical reads', async () => {
    const patientId = await world.patient([author]);
    const draft = await draftWithText(patientId);

    for (let index = 0; index < 5; index += 1) {
      expect((await world.api.get(`/notes/${draft.id}`, author.session)).statusCode).toBe(200);
    }
  });
});

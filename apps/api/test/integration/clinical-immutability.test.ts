import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { careAssignment, careRelationship } from '../../src/db/schema/care.js';
import { clinicalNote, encounter } from '../../src/db/schema/clinical.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asProfessional, openDraft, signDraft, type OpenedNote } from '../support/clinical.js';
import { createTestPatient } from '../support/patients.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

/**
 * The immutability rules of the clinical tables, enforced by triggers (clinical-records, "Draft,
 * signing and immutability"; "Addenda and corrections"; authorization AUZ-11). Everything runs as
 * `app_rw` unless the test says otherwise; the few tests that use the migration owner prove the
 * rules hold against the strongest role the application has, not only against the runtime one.
 */
let runtime: DbHandle;
let owner: pg.Client;
let org: TestTenant;
let author: string;
let colleague: string;
let reader: string;
let counter = 0;

const IMMUTABLE = '23000';
const NOT_ALLOWED = '42501';
const MISSING_PARENT = '23503';

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  org = await createTestTenant(runtime, { slug: 'clinical-immutability' });
  author = (await createTestProfessional(runtime, org.id)).professionalId;
  colleague = (await createTestProfessional(runtime, org.id)).professionalId;
  reader = (await createTestProfessional(runtime, org.id)).professionalId;
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

async function freshPatient(): Promise<string> {
  counter += 1;
  return createTestPatient(runtime, org.id, { familyName: `Inmutable${String(counter)}` });
}

async function assign(patientId: string, professionalId: string) {
  await asTenant(runtime, org.id, (tx) =>
    tx.insert(careAssignment).values({
      tenantId: org.id,
      patientId,
      professionalId,
      assignedBy: randomUUID(),
    }),
  );
}

/** A draft by `author`, with a treating colleague on the same patient. */
async function draftWithColleague(
  options: { visibility?: 'default' | 'author_only'; templateKind?: string } = {},
) {
  const patientId = await freshPatient();
  await assign(patientId, colleague);
  const opened = await asProfessional(runtime, org.id, author, (tx) =>
    openDraft(tx, { tenantId: org.id, patientId, authorId: author, ...options }),
  );
  return { patientId, ...opened };
}

async function signedNote(options: { visibility?: 'default' | 'author_only' } = {}) {
  const made = await draftWithColleague(options);
  await asProfessional(runtime, org.id, author, (tx) =>
    signDraft(tx, {
      id: made.noteId,
      tenantId: org.id,
      patientId: made.patientId,
      authorProfessionalId: author,
      templateKind: 'general',
      visibility: options.visibility ?? 'default',
    }),
  );
  return made;
}

const run = (professionalId: string, statement: ReturnType<typeof sql>) =>
  asProfessional(runtime, org.id, professionalId, (tx) => tx.execute(statement));

/** The shape of a database error as Drizzle wraps it: the driver error is the `cause`. */
const failure = (code: string, message?: RegExp): { cause: Record<string, unknown> } => ({
  cause:
    message === undefined ? { code } : { code, message: expect.stringMatching(message) as unknown },
});

/** Runs a statement as the migration owner inside a transaction that is always rolled back. */
async function asOwner(professionalId: string | null, statement: string) {
  await owner.query('BEGIN');
  try {
    await owner.query(
      `SELECT set_config('app.tenant_id', $1, true), set_config('app.professional_id', $2, true)`,
      [org.id, professionalId ?? ''],
    );
    return await owner.query(statement);
  } finally {
    await owner.query('ROLLBACK');
  }
}

describe('a draft', () => {
  it('lets its author save content and move the revision forward by exactly one', async () => {
    const { noteId } = await draftWithColleague();

    await run(
      author,
      sql`UPDATE clinical_note SET draft_content_enc = ${Buffer.from([9])}, draft_revision = 1 WHERE id = ${noteId}`,
    );
    const [row] = await asProfessional(runtime, org.id, author, (tx) =>
      tx.select().from(clinicalNote).where(eq(clinicalNote.id, noteId)),
    );

    expect(row?.draftRevision).toBe(1);
    expect(row?.status).toBe('draft');
  });

  it('refuses a revision that skips or repeats a number', async () => {
    const { noteId } = await draftWithColleague();

    for (const revision of [0, 2, 5]) {
      await expect(
        run(
          author,
          sql`UPDATE clinical_note SET draft_content_enc = ${Buffer.from([1])}, draft_revision = ${revision} WHERE id = ${noteId}`,
        ),
      ).rejects.toMatchObject(failure(IMMUTABLE, /revision/));
    }
  });

  it('refuses to change who wrote it, which patient it is for, or its template', async () => {
    const { noteId } = await draftWithColleague();
    const other = await freshPatient();

    for (const change of [
      sql`author_professional_id = ${colleague}`,
      sql`patient_id = ${other}`,
      sql`template_kind = 'psychology'`,
      sql`template_version = 2`,
    ]) {
      await expect(
        run(
          author,
          sql`UPDATE clinical_note SET ${change}, draft_revision = 1 WHERE id = ${noteId}`,
        ),
      ).rejects.toBeTruthy();
    }
  });

  it('cannot be signed without a signed version of its content', async () => {
    const { noteId } = await draftWithColleague();

    await expect(
      run(
        author,
        sql`UPDATE clinical_note SET status = 'signed', draft_content_enc = NULL WHERE id = ${noteId}`,
      ),
    ).rejects.toMatchObject(failure(IMMUTABLE, /version/));
  });

  it('lets the author restrict it to themselves while it is a draft, and follows on the encounter', async () => {
    const { noteId, encounterId } = await draftWithColleague();

    await run(
      author,
      sql`UPDATE clinical_note SET visibility = 'author_only', draft_revision = 1 WHERE id = ${noteId}`,
    );
    const [enc] = await asProfessional(runtime, org.id, author, (tx) =>
      tx
        .select({ visibility: encounter.visibility })
        .from(encounter)
        .where(eq(encounter.id, encounterId)),
    );

    expect(enc?.visibility).toBe('author_only');
  });
});

describe('a signed entry', () => {
  it('records the server time, not the one the client sent', async () => {
    const made = await draftWithColleague();
    await asProfessional(runtime, org.id, author, async (tx) => {
      await tx.execute(
        sql`INSERT INTO note_version (tenant_id, note_id, patient_id, author_professional_id, visibility, template_kind,
                                      template_version, version_no, content_enc, content_hash, signed_at)
            VALUES (${org.id}, ${made.noteId}, ${made.patientId}, ${author}, 'default', 'general', 1, 1,
                    ${Buffer.from([1])}, ${'d'.repeat(64)}, '2001-01-01T00:00:00Z')`,
      );
      await tx.execute(
        sql`UPDATE clinical_note SET status = 'signed', signed_at = '2001-01-01T00:00:00Z', draft_content_enc = NULL WHERE id = ${made.noteId}`,
      );
    });

    const rows = await asProfessional(runtime, org.id, author, async (tx) => ({
      note: await tx.execute<{ signed_at: string }>(
        sql`SELECT signed_at FROM clinical_note WHERE id = ${made.noteId}`,
      ),
      version: await tx.execute<{ signed_at: string }>(
        sql`SELECT signed_at FROM note_version WHERE note_id = ${made.noteId}`,
      ),
    }));

    for (const row of [rows.note.rows[0], rows.version.rows[0]]) {
      expect(new Date(row?.signed_at ?? 0).getFullYear()).toBeGreaterThanOrEqual(2026);
    }
  });

  it('cannot be edited, re-signed, moved back to draft or restricted afterwards, by anyone', async () => {
    const { noteId } = await signedNote();

    const attempts: [string, ReturnType<typeof sql>][] = [
      ['content', sql`draft_content_enc = ${Buffer.from([7])}`],
      ['back to draft', sql`status = 'draft', signed_at = NULL`],
      ['sign again', sql`status = 'signed'`],
      ['restrict visibility (AUZ-11)', sql`visibility = 'author_only'`],
      ['template', sql`template_kind = 'psychology'`],
      ['revision', sql`draft_revision = 9`],
    ];
    for (const [label, change] of attempts) {
      await expect(
        run(author, sql`UPDATE clinical_note SET ${change} WHERE id = ${noteId}`),
        `author: ${label}`,
      ).rejects.toBeTruthy();
      await expect(
        run(colleague, sql`UPDATE clinical_note SET ${change} WHERE id = ${noteId}`),
        `treating colleague: ${label}`,
      ).rejects.toBeTruthy();
    }
    const [row] = await asProfessional(runtime, org.id, author, (tx) =>
      tx.select().from(clinicalNote).where(eq(clinicalNote.id, noteId)),
    );
    expect(row).toMatchObject({ status: 'signed', visibility: 'default', draftRevision: 0 });
  });

  it('is also immutable for the migration owner, who owns every table', async () => {
    const { noteId } = await signedNote();

    await expect(
      asOwner(author, `UPDATE clinical_note SET visibility = 'author_only' WHERE id = '${noteId}'`),
    ).rejects.toMatchObject({ code: IMMUTABLE });
    await expect(
      asOwner(
        author,
        `UPDATE clinical_note SET status = 'draft', signed_at = NULL WHERE id = '${noteId}'`,
      ),
    ).rejects.toMatchObject({ code: IMMUTABLE });
  });

  it('cannot be deleted, not even by the owner, and the tables cannot be emptied', async () => {
    const { noteId, encounterId } = await signedNote();

    for (const statement of [
      `DELETE FROM clinical_note WHERE id = '${noteId}'`,
      `DELETE FROM encounter WHERE id = '${encounterId}'`,
      `DELETE FROM note_version WHERE note_id = '${noteId}'`,
    ]) {
      await expect(asOwner(author, statement), statement).rejects.toMatchObject({
        code: IMMUTABLE,
      });
    }
    for (const table of ['clinical_note', 'encounter', 'note_version', 'addendum']) {
      await expect(asOwner(author, `TRUNCATE ${table} CASCADE`), table).rejects.toMatchObject({
        code: IMMUTABLE,
      });
    }
  });

  it('keeps one immutable version, and a version can never be changed or added later', async () => {
    const { noteId, patientId } = await signedNote();

    await expect(
      run(
        author,
        sql`UPDATE note_version SET content_hash = ${'e'.repeat(64)} WHERE note_id = ${noteId}`,
      ),
    ).rejects.toMatchObject({ cause: { code: NOT_ALLOWED } });
    await expect(
      asOwner(
        author,
        `UPDATE note_version SET content_hash = '${'e'.repeat(64)}' WHERE note_id = '${noteId}'`,
      ),
    ).rejects.toMatchObject({ code: IMMUTABLE });
    // A second version for a note that is already signed.
    await expect(
      run(
        author,
        sql`INSERT INTO note_version (tenant_id, note_id, patient_id, author_professional_id, visibility, template_kind,
                                      template_version, version_no, content_enc, content_hash)
            VALUES (${org.id}, ${noteId}, ${patientId}, ${author}, 'default', 'general', 1, 2, ${Buffer.from([1])}, ${'f'.repeat(64)})`,
      ),
    ).rejects.toMatchObject(failure(IMMUTABLE, /draft/));
  });
});

describe('entered in error', () => {
  const mark = (professionalId: string, noteId: string, reason = 'Paciente equivocado') =>
    run(
      professionalId,
      sql`UPDATE clinical_note SET status = 'entered_in_error', error_reason = ${reason} WHERE id = ${noteId}`,
    );

  it('lets the author mark a signed entry, keeps its content and records who and when', async () => {
    const { noteId } = await signedNote();

    await mark(author, noteId);
    const rows = await asProfessional(runtime, org.id, author, async (tx) => ({
      note: await tx.select().from(clinicalNote).where(eq(clinicalNote.id, noteId)),
      versions: await tx.execute<{ content_hash: string }>(
        sql`SELECT content_hash FROM note_version WHERE note_id = ${noteId}`,
      ),
    }));

    expect(rows.note[0]).toMatchObject({
      status: 'entered_in_error',
      errorReason: 'Paciente equivocado',
      errorMarkedBy: author,
    });
    expect(rows.note[0]?.errorMarkedAt).toBeInstanceOf(Date);
    expect(rows.versions.rows).toHaveLength(1);
  });

  it('lets another treating professional mark it, and records that professional (not the author)', async () => {
    const { noteId } = await signedNote();

    await mark(colleague, noteId, 'Duplicado');
    const [row] = await asProfessional(runtime, org.id, author, (tx) =>
      tx.select().from(clinicalNote).where(eq(clinicalNote.id, noteId)),
    );

    expect(row).toMatchObject({ status: 'entered_in_error', errorMarkedBy: colleague });
  });

  it('refuses a professional who can read it only through sharing (not treating)', async () => {
    const { noteId } = await signedNote();
    await asTenant(runtime, org.id, (tx) =>
      tx
        .update(tenant)
        .set({ settings: { clinicalSharing: true, sharedTemplates: ['general'] } })
        .where(eq(tenant.id, org.id)),
    );
    try {
      const visible = await asProfessional(runtime, org.id, reader, (tx) =>
        tx.select({ id: clinicalNote.id }).from(clinicalNote).where(eq(clinicalNote.id, noteId)),
      );
      expect(visible).toHaveLength(1);

      await expect(mark(reader, noteId)).rejects.toMatchObject(failure(NOT_ALLOWED));
    } finally {
      await asTenant(runtime, org.id, (tx) =>
        tx.update(tenant).set({ settings: {} }).where(eq(tenant.id, org.id)),
      );
    }
  });

  it('requires a reason', async () => {
    const { noteId } = await signedNote();

    for (const reason of ['', '   ']) {
      await expect(mark(author, noteId, reason)).rejects.toMatchObject({
        cause: { code: '23514' },
      });
    }
  });

  it('is final: nothing changes afterwards, and it cannot be marked twice', async () => {
    const { noteId } = await signedNote();
    await mark(author, noteId);

    await expect(mark(author, noteId, 'Otra razón')).rejects.toMatchObject(failure(IMMUTABLE));
    await expect(
      run(
        author,
        sql`UPDATE clinical_note SET status = 'signed', error_reason = NULL WHERE id = ${noteId}`,
      ),
    ).rejects.toBeTruthy();
  });

  it('lets the author also mark an unsigned draft (a draft opened on the wrong patient)', async () => {
    const { noteId } = await draftWithColleague();

    await mark(author, noteId, 'Abierto en otro paciente');
    const [row] = await asProfessional(runtime, org.id, author, (tx) =>
      tx.select().from(clinicalNote).where(eq(clinicalNote.id, noteId)),
    );

    expect(row).toMatchObject({ status: 'entered_in_error', signedAt: null });
  });
});

describe('addenda', () => {
  async function addendum(
    professionalId: string,
    noteId: string,
    patientId: string,
    overrides: { visibility?: string; template?: string } = {},
  ) {
    return run(
      professionalId,
      sql`INSERT INTO addendum (tenant_id, note_id, patient_id, author_professional_id, visibility, template_kind, kind, reason, content_enc)
          VALUES (${org.id}, ${noteId}, ${patientId}, ${professionalId}, ${overrides.visibility ?? 'default'},
                  ${overrides.template ?? 'general'}, 'correction', 'Corrección', ${Buffer.from([1])})`,
    );
  }

  it('lets a treating professional add one, whoever wrote the note', async () => {
    const { noteId, patientId } = await signedNote();

    await addendum(colleague, noteId, patientId);
    await addendum(author, noteId, patientId);
    const rows = await asProfessional(runtime, org.id, author, (tx) =>
      tx.execute<{ author_professional_id: string }>(
        sql`SELECT author_professional_id FROM addendum WHERE note_id = ${noteId} ORDER BY created_at, id`,
      ),
    );

    expect(rows.rows.map((row) => row.author_professional_id).sort()).toEqual(
      [author, colleague].sort(),
    );
  });

  it('refuses a professional who reads the note only through sharing', async () => {
    const { noteId, patientId } = await signedNote();
    await asTenant(runtime, org.id, (tx) =>
      tx
        .update(tenant)
        .set({ settings: { clinicalSharing: true, sharedTemplates: ['general'] } })
        .where(eq(tenant.id, org.id)),
    );
    try {
      await expect(addendum(reader, noteId, patientId)).rejects.toMatchObject({
        cause: { code: NOT_ALLOWED },
      });
    } finally {
      await asTenant(runtime, org.id, (tx) =>
        tx.update(tenant).set({ settings: {} }).where(eq(tenant.id, org.id)),
      );
    }
  });

  it('is refused on a draft, and on an entry marked in error', async () => {
    const draft = await draftWithColleague();
    const wrong = await signedNote();
    await run(
      author,
      sql`UPDATE clinical_note SET status = 'entered_in_error', error_reason = 'Duplicado' WHERE id = ${wrong.noteId}`,
    );

    await expect(addendum(author, draft.noteId, draft.patientId)).rejects.toMatchObject(
      failure(IMMUTABLE, /signed/),
    );
    await expect(addendum(author, wrong.noteId, wrong.patientId)).rejects.toMatchObject(
      failure(IMMUTABLE, /signed/),
    );
  });

  it("must repeat the note's own visibility and template, so the policies see the right thing", async () => {
    const { noteId, patientId } = await signedNote();

    await expect(
      addendum(author, noteId, patientId, { visibility: 'author_only' }),
    ).rejects.toMatchObject(failure(MISSING_PARENT));
    await expect(
      addendum(author, noteId, patientId, { template: 'psychology' }),
    ).rejects.toMatchObject(failure(MISSING_PARENT));
    const other = await freshPatient();
    await expect(addendum(author, noteId, other)).rejects.toMatchObject(failure(MISSING_PARENT));
  });

  it('is insert-only: no update, no delete, for the runtime role or the owner', async () => {
    const { noteId, patientId } = await signedNote();
    await addendum(author, noteId, patientId);

    await expect(
      run(author, sql`UPDATE addendum SET reason = 'Otra' WHERE note_id = ${noteId}`),
    ).rejects.toMatchObject({ cause: { code: NOT_ALLOWED } });
    await expect(
      asOwner(author, `UPDATE addendum SET reason = 'Otra' WHERE note_id = '${noteId}'`),
    ).rejects.toMatchObject({ code: IMMUTABLE });
    await expect(
      asOwner(author, `DELETE FROM addendum WHERE note_id = '${noteId}'`),
    ).rejects.toMatchObject({ code: IMMUTABLE });
  });

  it('requires a reason and a known kind', async () => {
    const { noteId, patientId } = await signedNote();

    for (const [kind, reason] of [
      ['correction', ' '],
      ['opinion', 'Motivo'],
    ] as const) {
      await expect(
        run(
          author,
          sql`INSERT INTO addendum (tenant_id, note_id, patient_id, author_professional_id, visibility, template_kind, kind, reason, content_enc)
              VALUES (${org.id}, ${noteId}, ${patientId}, ${author}, 'default', 'general', ${kind}, ${reason}, ${Buffer.from([1])})`,
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });
});

describe('encounters feed the care relationship (source 2)', () => {
  const relationship = async (patientId: string, professionalId: string) => {
    const rows = await asTenant(runtime, org.id, (tx) =>
      tx.select().from(careRelationship).where(eq(careRelationship.patientId, patientId)),
    );
    return rows.find((row) => row.professionalId === professionalId);
  };

  it('makes the author a treating professional the moment the encounter exists', async () => {
    const patientId = await freshPatient();
    expect(await relationship(patientId, author)).toBeUndefined();

    await asProfessional(runtime, org.id, author, (tx) =>
      openDraft(tx, { tenantId: org.id, patientId, authorId: author }),
    );

    expect(await relationship(patientId, author)).toMatchObject({ encounters: 1, active: true });
  });

  it('counts a second encounter, and only for the professional who opened it', async () => {
    const patientId = await freshPatient();
    for (const who of [author, author, colleague]) {
      await asProfessional(runtime, org.id, who, (tx) =>
        openDraft(tx, { tenantId: org.id, patientId, authorId: who }),
      );
    }

    expect(await relationship(patientId, author)).toMatchObject({ encounters: 2, active: true });
    expect(await relationship(patientId, colleague)).toMatchObject({ encounters: 1, active: true });
  });

  it('takes the relationship back when the only encounter is marked in error (wrong patient)', async () => {
    const patientId = await freshPatient();
    const opened = await asProfessional(runtime, org.id, author, (tx) =>
      openDraft(tx, { tenantId: org.id, patientId, authorId: author }),
    );

    await run(
      author,
      sql`UPDATE clinical_note SET status = 'entered_in_error', error_reason = 'Paciente equivocado' WHERE id = ${opened.noteId}`,
    );

    expect(await relationship(patientId, author)).toMatchObject({ encounters: 0, active: false });
  });

  it('keeps the relationship while another encounter, or an assignment, still stands', async () => {
    const patientId = await freshPatient();
    const first = await asProfessional(runtime, org.id, author, (tx) =>
      openDraft(tx, { tenantId: org.id, patientId, authorId: author }),
    );
    await asProfessional(runtime, org.id, author, (tx) =>
      openDraft(tx, { tenantId: org.id, patientId, authorId: author }),
    );

    await run(
      author,
      sql`UPDATE clinical_note SET status = 'entered_in_error', error_reason = 'Duplicado' WHERE id = ${first.noteId}`,
    );

    expect(await relationship(patientId, author)).toMatchObject({ encounters: 1, active: true });
  });

  it('cannot be faked: an encounter written for somebody else is refused', async () => {
    const patientId = await freshPatient();

    await expect(
      asProfessional(runtime, org.id, colleague, (tx) =>
        openDraft(tx, { tenantId: org.id, patientId, authorId: author }),
      ),
    ).rejects.toMatchObject(failure(NOT_ALLOWED));
    expect(await relationship(patientId, author)).toBeUndefined();
  });

  it('does not let an encounter change except its visibility, and only while the note is a draft', async () => {
    const made = (await signedNote()) as OpenedNote & { patientId: string };

    await expect(
      run(
        author,
        sql`UPDATE encounter SET visibility = 'author_only' WHERE id = ${made.encounterId}`,
      ),
    ).rejects.toMatchObject(failure(IMMUTABLE));
    await expect(
      run(
        author,
        sql`UPDATE encounter SET template_kind = 'psychology' WHERE id = ${made.encounterId}`,
      ),
    ).rejects.toMatchObject({ cause: { code: NOT_ALLOWED } });
  });
});

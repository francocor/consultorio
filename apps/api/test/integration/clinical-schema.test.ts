import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { careAssignment } from '../../src/db/schema/care.js';
import { clinicalNote, encounter } from '../../src/db/schema/clinical.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { asProfessional, openDraft } from '../support/clinical.js';
import { createTestPatient } from '../support/patients.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

/**
 * The clinical tables (clinical-records, "Encounter notes", "Clinical access restriction"). Every
 * check runs as `app_rw`, the role the API uses, so row level security and the privileges are the
 * real ones. The triggers have their own file (clinical-immutability.test.ts).
 */
const TABLES = ['encounter', 'clinical_note', 'note_version', 'addendum'] as const;

let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;
let author: string;
let colleague: string;
let patientId: string;
let noteId: string;
let encounterId: string;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'clinical-schema-a' });
  b = await createTestTenant(runtime, { slug: 'clinical-schema-b' });
  author = (await createTestProfessional(runtime, a.id)).professionalId;
  colleague = (await createTestProfessional(runtime, a.id)).professionalId;
  patientId = await createTestPatient(runtime, a.id);
  // Opening an encounter needs a care relationship that comes from elsewhere (D20).
  await asTenant(runtime, a.id, (tx) =>
    tx.insert(careAssignment).values({
      tenantId: a.id,
      patientId,
      professionalId: author,
      assignedBy: randomUUID(),
    }),
  );
  const opened = await asProfessional(runtime, a.id, author, (tx) =>
    openDraft(tx, { tenantId: a.id, patientId, authorId: author }),
  );
  noteId = opened.noteId;
  encounterId = opened.encounterId;
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

describe('the clinical tables are protected by the database', () => {
  it.each(TABLES)('%s has row level security enabled and forced', async (table) => {
    const result = await owner.query<{ enabled: boolean; forced: boolean }>(
      `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE relname = $1`,
      [table],
    );

    expect(result.rows).toEqual([{ enabled: true, forced: true }]);
  });

  it.each(TABLES)(
    '%s carries the tenant policy and the two restrictive clinical policies',
    async (table) => {
      const result = await owner.query<{ policyname: string; permissive: string }>(
        `SELECT policyname, permissive FROM pg_policies WHERE tablename = $1 ORDER BY policyname`,
        [table],
      );
      const names = result.rows.map((row) => row.policyname);

      expect(names).toEqual(
        expect.arrayContaining([
          'tenant_isolation',
          'clinical_professionals_only',
          'clinical_scope',
        ]),
      );
      const restrictive = result.rows
        .filter((row) => row.permissive === 'RESTRICTIVE')
        .map((row) => row.policyname);
      expect(restrictive).toEqual(
        expect.arrayContaining(['clinical_professionals_only', 'clinical_scope']),
      );
    },
  );

  it.each(TABLES)('%s: the runtime role can never delete or truncate', async (table) => {
    const result = await owner.query<{ del: boolean; trunc: boolean }>(
      `SELECT has_table_privilege('app_rw', $1, 'DELETE') AS del,
              has_table_privilege('app_rw', $1, 'TRUNCATE') AS trunc`,
      [table],
    );

    expect(result.rows).toEqual([{ del: false, trunc: false }]);
  });

  it.each(['note_version', 'addendum'])(
    '%s is insert-only for the runtime role (no UPDATE privilege at all)',
    async (table) => {
      const result = await owner.query<{ upd: boolean; ins: boolean }>(
        `SELECT has_table_privilege('app_rw', $1, 'UPDATE') AS upd,
                has_table_privilege('app_rw', $1, 'INSERT') AS ins`,
        [table],
      );

      expect(result.rows).toEqual([{ upd: false, ins: true }]);
    },
  );

  it('refuses a DELETE from the runtime role with insufficient_privilege', async () => {
    await expect(
      asProfessional(runtime, a.id, author, (tx) =>
        tx.execute(sql`DELETE FROM clinical_note WHERE id = ${noteId}`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('who sees an encounter and its note', () => {
  it('shows them to their author', async () => {
    const rows = await asProfessional(runtime, a.id, author, async (tx) => ({
      notes: await tx.select({ id: clinicalNote.id }).from(clinicalNote),
      encounters: await tx.select({ id: encounter.id }).from(encounter),
    }));

    expect(rows.notes.map((row) => row.id)).toContain(noteId);
    expect(rows.encounters.map((row) => row.id)).toContain(encounterId);
  });

  it('shows nothing to a transaction that is not a professional (owner, admin, reception)', async () => {
    const rows = await asTenant(runtime, a.id, async (tx) => ({
      notes: await tx.select({ id: clinicalNote.id }).from(clinicalNote),
      encounters: await tx.select({ id: encounter.id }).from(encounter),
    }));

    expect(rows.notes).toEqual([]);
    expect(rows.encounters).toEqual([]);
  });

  it('keeps a draft private to its author, even from a professional who treats the patient', async () => {
    // The colleague treats the patient (assignment), yet a draft is the author's working copy.
    await asTenant(runtime, a.id, (tx) =>
      tx.insert(careAssignment).values({
        tenantId: a.id,
        patientId,
        professionalId: colleague,
        assignedBy: randomUUID(),
      }),
    );

    const seen = await asProfessional(runtime, a.id, colleague, (tx) =>
      tx.select({ id: clinicalNote.id }).from(clinicalNote).where(eq(clinicalNote.id, noteId)),
    );
    const own = await asProfessional(runtime, a.id, author, (tx) =>
      tx.select({ id: clinicalNote.id }).from(clinicalNote).where(eq(clinicalNote.id, noteId)),
    );

    expect(seen).toEqual([]);
    expect(own).toHaveLength(1);
  });

  it("gives another organization's professional zero rows", async () => {
    const other = await createTestProfessional(runtime, b.id);

    const rows = await asProfessional(runtime, b.id, other.professionalId, (tx) =>
      tx.select({ id: clinicalNote.id }).from(clinicalNote),
    );

    expect(rows).toEqual([]);
  });
});

describe('the keys keep a row inside its organization and its patient', () => {
  it('refuses an encounter for a patient of another organization (composite key)', async () => {
    const foreignPatient = await createTestPatient(runtime, b.id);

    await expect(
      asProfessional(runtime, a.id, author, (tx) =>
        openDraft(tx, { tenantId: a.id, patientId: foreignPatient, authorId: author }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('allows one note per encounter', async () => {
    await expect(
      asProfessional(runtime, a.id, author, (tx) =>
        tx.insert(clinicalNote).values({
          tenantId: a.id,
          encounterId,
          patientId,
          authorProfessionalId: author,
          templateKind: 'general',
          templateVersion: 1,
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('records an optional appointment reference with no foreign key yet (extension point)', async () => {
    const appointmentId = randomUUID();

    const opened = await asProfessional(runtime, a.id, author, async (tx) => {
      const [row] = await tx
        .insert(encounter)
        .values({
          tenantId: a.id,
          patientId,
          authorProfessionalId: author,
          templateKind: 'general',
          appointmentId,
        })
        .returning({ appointmentId: encounter.appointmentId });
      return row;
    });

    expect(opened?.appointmentId).toBe(appointmentId);
  });

  it('rejects values outside the status and visibility vocabulary', async () => {
    for (const bad of [{ visibility: 'everyone' }, { templateKind: 'Not A Kind!' }]) {
      await expect(
        asProfessional(runtime, a.id, author, (tx) =>
          tx.insert(encounter).values({
            tenantId: a.id,
            patientId,
            authorProfessionalId: author,
            templateKind: 'general',
            ...bad,
          }),
        ),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    }
  });
});

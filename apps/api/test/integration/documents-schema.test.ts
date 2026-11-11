import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { careAssignment } from '../../src/db/schema/care.js';
import { document, type NewDocument } from '../../src/db/schema/documents.js';
import { tenant } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID, type Tx } from '../../src/platform/db/tenant-context.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { openDraft } from '../support/clinical.js';
import { createTestPatient } from '../support/patients.js';
import { at, createSchedulingWorld, insertAppointment } from '../support/scheduling.js';
import { asTenant, createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestProfessional } from '../support/users.js';

/**
 * The `document` table as the database itself enforces it, acting as `app_rw`: who can see which
 * rows, what can change, and that nothing can be removed. The service tests assume all of this.
 */
let runtime: DbHandle;
let owner: pg.Client;
let a: TestTenant;
let b: TestTenant;
let treating: { id: string; professionalId: string };
let colleague: { id: string; professionalId: string };
let patientId: string;

const run = createWithTenant;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  owner = new pg.Client({ connectionString: inject('ownerUrl') });
  await owner.connect();
  a = await createTestTenant(runtime, { slug: 'documents-schema-a' });
  b = await createTestTenant(runtime, { slug: 'documents-schema-b' });
  treating = await createTestProfessional(runtime, a.id);
  colleague = await createTestProfessional(runtime, a.id);
  patientId = await createTestPatient(runtime, a.id);
  await asTenant(runtime, a.id, (tx) =>
    tx.insert(careAssignment).values({
      tenantId: a.id,
      patientId,
      professionalId: treating.professionalId,
      assignedBy: randomUUID(),
    }),
  );
});

afterAll(async () => {
  await owner.end();
  await runtime.close();
});

function row(overrides: Partial<NewDocument> = {}): NewDocument {
  const id = overrides.id ?? uuidv7();
  return {
    id,
    tenantId: a.id,
    patientId,
    category: 'id_copy',
    classification: 'administrative',
    originalName: 'dni.pdf',
    declaredContentType: 'application/pdf',
    sizeBytes: 1000,
    objectKey: `t/${a.id}/quarantine/${id}`,
    uploadedBy: randomUUID(),
    ...overrides,
  };
}

const clinicalRow = (overrides: Partial<NewDocument> = {}) =>
  row({
    category: 'lab_result',
    classification: 'clinical',
    authorProfessionalId: treating.professionalId,
    ...overrides,
  });

/** Inserts as the uploader would: as a professional for clinical documents, plain otherwise. */
async function insert(
  values: NewDocument,
  as: { professionalId?: string; tenantId?: string } = {},
) {
  await run(runtime.db)(
    {
      tenantId: as.tenantId ?? a.id,
      userId: values.uploadedBy,
      ...(as.professionalId === undefined ? {} : { actingProfessionalId: as.professionalId }),
    },
    (tx) => tx.insert(document).values(values),
  );
  return values.id ?? '';
}

const visibleTo = (
  who: { professionalId?: string; userId?: string; tenantId?: string },
  id: string,
) =>
  run(runtime.db)(
    {
      tenantId: who.tenantId ?? a.id,
      userId: who.userId ?? randomUUID(),
      ...(who.professionalId === undefined ? {} : { actingProfessionalId: who.professionalId }),
    },
    async (tx: Tx) => {
      const found = await tx.select({ id: document.id }).from(document).where(eq(document.id, id));
      return found.length;
    },
  );

describe('who sees which document (row level security)', () => {
  it('shows an administrative document to anyone in the organization, and to nobody outside it', async () => {
    const id = await insert(row());

    expect(await visibleTo({}, id)).toBe(1);
    expect(await visibleTo({ professionalId: colleague.professionalId }, id)).toBe(1);
    expect(await visibleTo({ tenantId: b.id }, id)).toBe(0);
  });

  it('shows a clinical document only to a professional who may read it: the author, or a treating one', async () => {
    const id = await insert(clinicalRow(), { professionalId: treating.professionalId });

    expect(await visibleTo({ professionalId: treating.professionalId }, id)).toBe(1);
    // A colleague with no relationship to the patient, and sharing off, sees nothing.
    expect(await visibleTo({ professionalId: colleague.professionalId }, id)).toBe(0);
  });

  it('hides a clinical document from a transaction with no professional (owner, admin, reception), even in plain SQL', async () => {
    const id = await insert(clinicalRow(), { professionalId: treating.professionalId });

    expect(await visibleTo({}, id)).toBe(0);
    const counted = await asTenant(runtime, a.id, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from document where classification = 'clinical'`,
      ),
    );
    expect(counted.rows[0]?.n).toBe(0);
  });

  it('lets the system itself (jobs) see and update every document to scan it', async () => {
    const administrative = await insert(row());
    const clinical = await insert(clinicalRow(), { professionalId: treating.professionalId });

    for (const id of [administrative, clinical]) {
      const seen = await run(runtime.db)({ tenantId: a.id, userId: SYSTEM_USER_ID }, async (tx) => {
        const updated = await tx
          .update(document)
          .set({ scanAttempts: 1 })
          .where(eq(document.id, id))
          .returning({ id: document.id });
        return updated.length;
      });
      expect(seen).toBe(1);
    }
  });

  it('refuses a reception transaction that tries to insert a clinical document', async () => {
    await expect(insert(clinicalRow())).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('refuses a professional inserting a clinical document in the name of another', async () => {
    await expect(
      insert(clinicalRow({ authorProfessionalId: colleague.professionalId }), {
        professionalId: treating.professionalId,
      }),
    ).resolves.toBeDefined();
    // The author is the colleague, so the treating professional only passes through the
    // relationship; a stranger with no relationship does not.
    const stranger = await createTestProfessional(runtime, a.id);
    await expect(
      insert(clinicalRow({ authorProfessionalId: colleague.professionalId }), {
        professionalId: stranger.professionalId,
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('the shape of a row', () => {
  it('requires a professional uploader for a clinical document, and none for an administrative one', async () => {
    await expect(
      insert(clinicalRow({ authorProfessionalId: null }), {
        professionalId: treating.professionalId,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(insert(row())).resolves.toBeDefined();
  });

  it('keeps the classification in step with the category', async () => {
    await expect(
      insert(row({ category: 'lab_result', classification: 'administrative' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      insert(clinicalRow({ category: 'id_copy' }), { professionalId: treating.professionalId }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('accepts only the four statuses and the known types and sizes', async () => {
    await expect(insert(row({ status: 'deleted' }))).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(insert(row({ sizeBytes: 0 }))).rejects.toMatchObject({ cause: { code: '23514' } });
    await expect(
      insert(row({ declaredContentType: 'application/x-msdownload' })),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('refuses a patient of another organization (composite foreign key)', async () => {
    const foreign = await createTestPatient(runtime, b.id);

    await expect(insert(row({ patientId: foreign }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });

  it('links a document to an appointment of its own organization, and to no other (composite foreign key)', async () => {
    const world = await createSchedulingWorld(runtime, a.id);
    const own = await asTenant(runtime, a.id, (tx) =>
      insertAppointment(tx, world, { start: at(0), patientId }),
    );
    const otherWorld = await createSchedulingWorld(runtime, b.id);
    const foreign = await asTenant(runtime, b.id, (tx) =>
      insertAppointment(tx, otherWorld, { start: at(0) }),
    );

    await expect(insert(row({ appointmentId: own.id }))).resolves.toBeDefined();
    await expect(insert(row({ appointmentId: foreign.id }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
    await expect(insert(row({ appointmentId: randomUUID() }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
    // The same for the encounter the document belongs to (clinical record, migration 0034).
    const opened = await run(runtime.db)(
      { tenantId: a.id, userId: randomUUID(), actingProfessionalId: treating.professionalId },
      (tx) => openDraft(tx, { tenantId: a.id, patientId, authorId: treating.professionalId }),
    );
    await expect(insert(row({ encounterId: opened.encounterId }))).resolves.toBeDefined();
    await expect(insert(row({ encounterId: randomUUID() }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });

  it('refuses a replacement that points at a document of another patient or organization', async () => {
    const original = await insert(row());
    const otherTenantPatient = await createTestPatient(runtime, b.id);
    const foreignId = uuidv7();
    await run(runtime.db)({ tenantId: b.id, userId: randomUUID() }, (tx) =>
      tx.insert(document).values({
        ...row({ id: foreignId, patientId: otherTenantPatient }),
        tenantId: b.id,
        objectKey: `t/${b.id}/quarantine/${foreignId}`,
      }),
    );

    await expect(insert(row({ replacesDocumentId: original }))).resolves.toBeDefined();
    await expect(insert(row({ replacesDocumentId: foreignId }))).rejects.toMatchObject({
      cause: { code: '23503' },
    });
  });
});

describe('nothing is removed, and what is stored does not change', () => {
  it('lets the runtime role neither delete nor truncate', async () => {
    const id = await insert(row());

    await expect(
      asTenant(runtime, a.id, (tx) => tx.delete(document).where(eq(document.id, id))),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) => tx.execute(sql`truncate document`)),
    ).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('keeps the identity of a document: patient, uploader, name, declared type, size and links', async () => {
    const id = await insert(row());
    const changes: Partial<NewDocument>[] = [
      { patientId: await createTestPatient(runtime, a.id) },
      { uploadedBy: randomUUID() },
      { originalName: 'otro.pdf' },
      { declaredContentType: 'image/png' },
      { replacesDocumentId: id },
    ];

    for (const change of changes) {
      await expect(
        asTenant(runtime, a.id, (tx) => tx.update(document).set(change).where(eq(document.id, id))),
        JSON.stringify(Object.keys(change)),
      ).rejects.toMatchObject({ cause: { code: '42501' } });
    }
  });

  it('never changes the hash or the detected type once the scan has set them', async () => {
    const id = await insert(row());
    const scan = {
      status: 'available' as const,
      sha256: 'a'.repeat(64),
      contentType: 'application/pdf',
      scanResult: 'clean',
    };
    await asTenant(runtime, a.id, (tx) => tx.update(document).set(scan).where(eq(document.id, id)));

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx
          .update(document)
          .set({ sha256: 'b'.repeat(64) })
          .where(eq(document.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.update(document).set({ contentType: 'image/png' }).where(eq(document.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('follows the lifecycle: quarantined to available or rejected, available to hidden, nothing back', async () => {
    const toAvailable = await insert(row());
    const toRejected = await insert(row());
    const available = {
      status: 'available' as const,
      sha256: 'c'.repeat(64),
      contentType: 'application/pdf',
      scanResult: 'clean',
    };
    const set = (id: string, values: Partial<NewDocument>) =>
      asTenant(runtime, a.id, (tx) => tx.update(document).set(values).where(eq(document.id, id)));

    await expect(set(toAvailable, available)).resolves.toBeDefined();
    await expect(
      set(toRejected, { status: 'rejected', scanResult: 'infected', rejectionReason: 'infected' }),
    ).resolves.toBeDefined();

    // Hiding needs a reason and a time.
    await expect(set(toAvailable, { status: 'hidden' })).rejects.toMatchObject({
      cause: { code: '23514' },
    });
    await expect(
      set(toAvailable, {
        status: 'hidden',
        hiddenAt: new Date(),
        hiddenBy: randomUUID(),
        hiddenReason: 'Paciente equivocado',
      }),
    ).resolves.toBeDefined();

    // No way back, and a rejected file never becomes available.
    await expect(set(toAvailable, { status: 'available' })).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(set(toRejected, available)).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(set(toRejected, { status: 'quarantined' })).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('refuses an available document without a hash and a detected type', async () => {
    const id = await insert(row());

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.update(document).set({ status: 'available' }).where(eq(document.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('refuses to point the object key somewhere else, except when the scan moves it', async () => {
    const id = await insert(row());
    const moved = `t/${a.id}/docs/${id}`;

    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx.update(document).set({ objectKey: moved }).where(eq(document.id, id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      asTenant(runtime, a.id, (tx) =>
        tx
          .update(document)
          .set({
            objectKey: moved,
            status: 'available',
            sha256: 'd'.repeat(64),
            contentType: 'application/pdf',
            scanResult: 'clean',
          })
          .where(eq(document.id, id)),
      ),
    ).resolves.toBeDefined();
  });
});

describe('the table is a tenant table like any other', () => {
  it('keeps the tenant column bound to the transaction', async () => {
    await expect(
      run(runtime.db)({ tenantId: b.id, userId: randomUUID() }, (tx) =>
        tx.insert(document).values(row()),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('has row level security forced and the clinical policy in place', async () => {
    const policies = await owner.query<{ policyname: string; permissive: string }>(
      `select policyname, permissive from pg_policies where tablename = 'document' order by 1`,
    );
    const forced = await owner.query<{ relforcerowsecurity: boolean }>(
      `select relforcerowsecurity from pg_class where relname = 'document'`,
    );

    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
    expect(policies.rows.map((policy) => policy.policyname)).toEqual([
      'document_classification',
      'tenant_isolation',
    ]);
    expect(
      policies.rows.find((policy) => policy.policyname === 'document_classification')?.permissive,
    ).toBe('RESTRICTIVE');
  });

  it('is isolated from the tenant table itself (sanity: a tenant row still reads)', async () => {
    const found = await asTenant(runtime, a.id, (tx) =>
      tx.select({ id: tenant.id }).from(tenant).where(eq(tenant.id, a.id)),
    );
    expect(found).toHaveLength(1);
  });
});

describe('a clinical document leaves a clinical footprint (JD-S2 C3, D20)', () => {
  const hasFootprint = (id: string) =>
    run(runtime.db)(
      { tenantId: a.id, userId: randomUUID(), actingProfessionalId: colleague.professionalId },
      async (tx) => {
        const result = await tx.execute<{ found: boolean }>(
          sql`select app.has_clinical_footprint(${id}::uuid) as found`,
        );
        return result.rows[0]?.found;
      },
    );

  it('marks the patient when a clinical document is written, and not for an administrative one', async () => {
    const withClinical = await createTestPatient(runtime, a.id);
    const withAdministrative = await createTestPatient(runtime, a.id);
    expect(await hasFootprint(withClinical)).toBe(false);

    await insert(row({ patientId: withAdministrative }));
    await insert(clinicalRow({ patientId: withClinical }), {
      professionalId: treating.professionalId,
    });

    expect(await hasFootprint(withAdministrative)).toBe(false);
    expect(await hasFootprint(withClinical)).toBe(true);
  });

  it('marks the patient when an administrative document becomes clinical', async () => {
    const reclassified = await createTestPatient(runtime, a.id);
    const id = await insert(row({ patientId: reclassified }));
    expect(await hasFootprint(reclassified)).toBe(false);

    await run(runtime.db)({ tenantId: a.id, userId: SYSTEM_USER_ID }, (tx) =>
      tx
        .update(document)
        .set({
          category: 'lab_result',
          classification: 'clinical',
          authorProfessionalId: treating.professionalId,
        })
        .where(eq(document.id, id)),
    );

    expect(await hasFootprint(reclassified)).toBe(true);
  });
});

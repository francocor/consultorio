import { randomUUID } from 'node:crypto';

import type { AuditAction, CreateUploadsResponse, DocumentDto } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { document } from '../../src/db/schema/documents.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID } from '../../src/platform/db/tenant-context.js';
import { minimalPdf } from '../../src/platform/files/test-files.js';
import {
  createDocumentsHarness,
  forceAvailable,
  type DocumentsHarness,
} from '../support/documents.js';
import { at, createSchedulingWorld, insertAppointment } from '../support/scheduling.js';
import { asTenant } from '../support/tenants.js';

let runtime: DbHandle;
let h: DocumentsHarness;
let other: DocumentsHarness;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = await createDocumentsHarness(runtime, 'docs-uploads');
  other = await createDocumentsHarness(runtime, 'docs-uploads-b');
});

afterAll(async () => {
  await h.close();
  await other.close();
  await runtime.close();
});

const pdf = (size = 2_000_000) => ({
  name: 'resultado.pdf',
  contentType: 'application/pdf',
  size,
});

const request = (patientId: string, extra: Record<string, unknown> = {}) => ({
  patientId,
  category: 'lab_result',
  files: [pdf()],
  ...extra,
});

/** Every row of the patient, as the system sees them (the staff roles see fewer on purpose). */
const rowsOf = (patientId: string) =>
  createWithTenant(runtime.db)({ tenantId: h.tenant.id, userId: SYSTEM_USER_ID }, (tx) =>
    tx.select().from(document).where(eq(document.patientId, patientId)),
  );

async function auditRows(action: AuditAction, patientId: string) {
  const rows = await asTenant(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === patientId);
}

describe('asking to upload: POST /documents/uploads', () => {
  it('answers with a presigned POST per file, bound to the quarantine key, the type and the size cap', async () => {
    const patientId = await h.patient();

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId),
    );

    expect(response.statusCode).toBe(200);
    const body = response.json<CreateUploadsResponse>();
    expect(body.uploads).toHaveLength(1);
    const upload = body.uploads[0];
    const rows = await rowsOf(patientId);
    expect(rows).toHaveLength(1);
    expect(upload?.id).toBe(rows[0]?.id);
    // Organization and key come from the server: the object waits in quarantine under the id.
    expect(rows[0]?.objectKey).toBe(`t/${h.tenant.id}/quarantine/${rows[0]?.id ?? ''}`);
    expect(upload?.upload.fields['key']).toBe(rows[0]?.objectKey);
    expect(upload?.upload.fields['Content-Type']).toBe('application/pdf');
    expect(rows[0]).toMatchObject({
      status: 'quarantined',
      classification: 'clinical',
      category: 'lab_result',
      originalName: 'resultado.pdf',
      declaredContentType: 'application/pdf',
      sizeBytes: 2_000_000,
      uploadCompletedAt: null,
      authorProfessionalId: h.professionalId,
    });
  });

  it('keeps the appointment the document came with, and refuses one of another patient', async () => {
    const patientId = await h.patient();
    const otherPatientId = await h.patient();
    const world = await createSchedulingWorld(runtime, h.tenant.id);
    const appointment = await asTenant(runtime, h.tenant.id, (tx) =>
      insertAppointment(tx, world, { start: at(0), patientId }),
    );

    const linked = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { appointmentId: appointment.id }),
    );
    const ofAnotherPatient = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(otherPatientId, { appointmentId: appointment.id }),
    );
    const unknown = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { appointmentId: randomUUID() }),
    );

    expect(linked.statusCode).toBe(200);
    expect((await rowsOf(patientId)).map((row) => row.appointmentId)).toEqual([appointment.id]);
    expect(ofAnotherPatient.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(await rowsOf(otherPatientId)).toHaveLength(0);
    expect(await rowsOf(patientId)).toHaveLength(1);
  });

  it('refuses 11 files in one request and stores nothing', async () => {
    const patientId = await h.patient();
    const files = Array.from({ length: 11 }, (_, i) => ({ ...pdf(), name: `f${String(i)}.pdf` }));

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { files }),
    );

    expect(response.statusCode).toBe(400);
    expect(await rowsOf(patientId)).toHaveLength(0);
  });

  it('accepts 10 files in one request', async () => {
    const patientId = await h.patient();
    const files = Array.from({ length: 10 }, (_, i) => ({
      ...pdf(1000),
      name: `f${String(i)}.pdf`,
    }));

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { files }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<CreateUploadsResponse>().uploads).toHaveLength(10);
    expect(await rowsOf(patientId)).toHaveLength(10);
  });

  it('refuses a file over the size cap and names the file and the field, not the content', async () => {
    const patientId = await h.patient();

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { files: [pdf(), pdf(35 * 1024 * 1024)] }),
    );

    expect(response.statusCode).toBe(400);
    const errors = response.json<{ errors: { path: string; i18nKey: string }[] }>().errors;
    expect(errors.some((error) => error.path === 'files.1.size')).toBe(true);
    expect(await rowsOf(patientId)).toHaveLength(0);
  });

  it('refuses a type outside the whitelist, such as an executable or an SVG', async () => {
    const patientId = await h.patient();

    for (const contentType of ['application/x-msdownload', 'image/svg+xml', 'text/html']) {
      const response = await h.api.post(
        '/documents/uploads',
        h.sessions.professional,
        request(patientId, { files: [{ ...pdf(), name: 'report.exe', contentType }] }),
      );
      expect(response.statusCode, contentType).toBe(400);
    }
    expect(await rowsOf(patientId)).toHaveLength(0);
  });

  it('sanitizes the name and never uses it to decide where the file goes', async () => {
    const patientId = await h.patient();

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { files: [{ ...pdf(), name: '../../other-tenant/file.pdf' }] }),
    );

    expect(response.statusCode).toBe(200);
    const [row] = await rowsOf(patientId);
    expect(row?.originalName).toBe('file.pdf');
    expect(row?.objectKey).toBe(`t/${h.tenant.id}/quarantine/${row?.id ?? ''}`);
    expect(row?.objectKey).not.toContain('other-tenant');
  });

  it('answers not found for a patient of another organization and stores nothing', async () => {
    const foreignPatient = await other.patient();

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(foreignPatient),
    );

    expect(response.statusCode).toBe(404);
    expect(
      await createWithTenant(runtime.db)(
        { tenantId: other.tenant.id, userId: SYSTEM_USER_ID },
        (tx) => tx.select().from(document).where(eq(document.patientId, foreignPatient)),
      ),
    ).toHaveLength(0);
    // And for a patient that does not exist at all: the same answer.
    expect(
      (await h.api.post('/documents/uploads', h.sessions.professional, request(randomUUID())))
        .statusCode,
    ).toBe(404);
  });

  it('takes the organization and the uploader from the session, never from the body', async () => {
    const patientId = await h.patient();

    const forged = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { tenantId: other.tenant.id, uploadedBy: randomUUID() }),
    );
    expect(forged.statusCode).toBe(400);

    await h.api.post('/documents/uploads', h.sessions.professional, request(patientId));
    const [row] = await rowsOf(patientId);
    expect(row?.tenantId).toBe(h.tenant.id);
    expect(row?.uploadedBy).toBe(h.sessions.professional.user.id);
  });

  it('needs a signed-in user', async () => {
    const patientId = await h.patient();

    expect((await h.api.post('/documents/uploads', null, request(patientId))).statusCode).toBe(401);
  });

  it('is refused in a read-only organization, like any new upload', async () => {
    const patientId = await h.patient();
    await asTenant(runtime, h.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ status: 'read_only', readOnlySince: new Date() })
        .where(eq(tenantTable.id, h.tenant.id)),
    );
    try {
      const response = await h.api.post(
        '/documents/uploads',
        h.sessions.professional,
        request(patientId),
      );
      expect(response.statusCode).toBe(402);
      expect(await rowsOf(patientId)).toHaveLength(0);
    } finally {
      await asTenant(runtime, h.tenant.id, (tx) =>
        tx
          .update(tenantTable)
          .set({ status: 'active', readOnlySince: null })
          .where(eq(tenantTable.id, h.tenant.id)),
      );
    }
  });
});

describe('who may upload which kind of document', () => {
  it('lets reception upload an administrative document and links it to the uploader', async () => {
    const patientId = await h.patient();

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.reception,
      request(patientId, {
        category: 'coverage_card',
        files: [{ ...pdf(), name: 'credencial.pdf' }],
      }),
    );

    expect(response.statusCode).toBe(200);
    const [row] = await rowsOf(patientId);
    expect(row).toMatchObject({ classification: 'administrative', authorProfessionalId: null });
  });

  it('refuses reception a clinical category, stores nothing and audits the denial', async () => {
    const patientId = await h.patient();

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.reception,
      request(patientId),
    );

    expect(response.statusCode).toBe(403);
    expect(await rowsOf(patientId)).toHaveLength(0);
    expect((await auditRows('access.denied', patientId)).length).toBe(1);
  });

  it('refuses an administrator and the owner a clinical category, and lets them upload administrative ones', async () => {
    const patientId = await h.patient();

    for (const session of [h.sessions.admin, h.sessions.owner]) {
      expect(
        (
          await h.api.post(
            '/documents/uploads',
            session,
            request(patientId, { category: 'imaging' }),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await h.api.post(
            '/documents/uploads',
            session,
            request(patientId, { category: 'id_copy' }),
          )
        ).statusCode,
      ).toBe(200);
    }
    expect((await rowsOf(patientId)).every((row) => row.classification === 'administrative')).toBe(
      true,
    );
  });

  it('refuses a professional who does not treat the patient a clinical document, but not an administrative one', async () => {
    const patientId = await h.patient({ treatedBy: 'nobody' });

    expect(
      (await h.api.post('/documents/uploads', h.sessions.professional, request(patientId)))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await h.api.post(
          '/documents/uploads',
          h.sessions.professional,
          request(patientId, { category: 'id_copy' }),
        )
      ).statusCode,
    ).toBe(200);
  });
});

describe('confirming the upload: POST /documents/:id/uploaded', () => {
  async function requested(patientId: string, session = h.sessions.professional) {
    const response = await h.api.post('/documents/uploads', session, request(patientId));
    const created = response.json<CreateUploadsResponse>().uploads[0];
    if (!created) throw new Error('no upload');
    return created;
  }

  it('records the confirmation, queues the scan in the same step and audits the upload', async () => {
    const patientId = await h.patient();
    const created = await requested(patientId);
    h.storage.acceptUpload(
      { ...created.upload, expiresAt: new Date(created.upload.expiresAt) },
      minimalPdf(),
      'application/pdf',
    );
    const before = h.jobs.pending('document.scan').length;

    const response = await h.api.post(`/documents/${created.id}/uploaded`, h.sessions.professional);

    expect(response.statusCode).toBe(200);
    const dto = response.json<DocumentDto>();
    expect(dto).toMatchObject({ id: created.id, status: 'quarantined', contentType: null });
    expect(dto.size).toBe(minimalPdf().length);
    const queued = h.jobs.pending('document.scan');
    expect(queued.length).toBe(before + 1);
    expect(queued.at(-1)?.payload).toMatchObject({ tenantId: h.tenant.id, documentId: created.id });
    const [row] = await rowsOf(patientId);
    expect(row?.uploadCompletedAt).toBeInstanceOf(Date);
    const [event] = await auditRows('document.uploaded', patientId);
    expect(event).toMatchObject({
      outcome: 'allow',
      resourceType: 'document',
      resourceId: created.id,
      actorUserId: h.sessions.professional.user.id,
    });
    expect(JSON.stringify(event?.metadata)).not.toContain('resultado');
  });

  it('answers conflict when the file never reached storage, and queues nothing', async () => {
    const patientId = await h.patient();
    const created = await requested(patientId);
    const before = h.jobs.pending('document.scan').length;

    const response = await h.api.post(`/documents/${created.id}/uploaded`, h.sessions.professional);

    expect(response.statusCode).toBe(409);
    expect(h.jobs.pending('document.scan').length).toBe(before);
    expect((await rowsOf(patientId))[0]?.uploadCompletedAt).toBeNull();
  });

  it('can be confirmed once, and only by whoever started it', async () => {
    const patientId = await h.patient();
    const created = await requested(patientId);
    h.storage.acceptUpload(
      { ...created.upload, expiresAt: new Date(created.upload.expiresAt) },
      minimalPdf(),
      'application/pdf',
    );

    // Somebody else with access to the patient cannot confirm it: they never saw it.
    expect(
      (await h.api.post(`/documents/${created.id}/uploaded`, h.sessions.reception)).statusCode,
    ).toBe(404);
    expect(
      (await h.api.post(`/documents/${created.id}/uploaded`, h.sessions.professional)).statusCode,
    ).toBe(200);
    expect(
      (await h.api.post(`/documents/${created.id}/uploaded`, h.sessions.professional)).statusCode,
    ).toBe(409);
  });

  it('does not exist for another organization', async () => {
    const patientId = await h.patient();
    const created = await requested(patientId);

    expect(
      (await other.api.post(`/documents/${created.id}/uploaded`, other.sessions.professional))
        .statusCode,
    ).toBe(404);
  });
});

describe('uploading a new version', () => {
  it('links the new file to the document it replaces and keeps the original', async () => {
    const patientId = await h.patient();
    const original = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('v1'),
    });
    await forceAvailable(runtime, h.tenant.id, original.id);

    const replacement = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { replacesDocumentId: original.id }),
    );

    expect(replacement.statusCode).toBe(200);
    const rows = await rowsOf(patientId);
    expect(rows).toHaveLength(2);
    const created = rows.find((row) => row.id !== original.id);
    expect(created?.replacesDocumentId).toBe(original.id);
    expect(rows.find((row) => row.id === original.id)?.status).toBe('available');
  });

  it('refuses to replace a document that is not available, one of another patient, or one already replaced', async () => {
    const patientId = await h.patient();
    const otherPatient = await h.patient();
    const pending = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('v1'),
    });
    const available = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('v2'),
    });
    await forceAvailable(runtime, h.tenant.id, available.id);
    const replace = (patient: string, id: string) =>
      h.api.post(
        '/documents/uploads',
        h.sessions.professional,
        request(patient, { replacesDocumentId: id }),
      );

    expect((await replace(patientId, pending.id)).statusCode).toBe(409);
    expect((await replace(otherPatient, available.id)).statusCode).toBe(404);
    expect((await replace(patientId, available.id)).statusCode).toBe(200);
    // The first replacement is still in flight: a second one for the same version is a conflict.
    expect((await replace(patientId, available.id)).statusCode).toBe(409);
  });

  it('keeps the classification of the document it replaces', async () => {
    const patientId = await h.patient();
    const available = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('v3'),
    });
    await forceAvailable(runtime, h.tenant.id, available.id);

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { category: 'id_copy', replacesDocumentId: available.id }),
    );

    expect(response.statusCode).toBe(400);
  });

  it('needs exactly one file', async () => {
    const patientId = await h.patient();
    const available = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('v4'),
    });
    await forceAvailable(runtime, h.tenant.id, available.id);

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { replacesDocumentId: available.id, files: [pdf(), pdf()] }),
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('warning about a duplicate before the file is sent', () => {
  it('returns the earlier document when the same content hash is already on the patient, and still allows the upload', async () => {
    const patientId = await h.patient();
    const hash = 'ab'.repeat(32);
    const first = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      name: 'primero.pdf',
      bytes: minimalPdf('d1'),
    });
    await forceAvailable(runtime, h.tenant.id, first.id, { sha256: hash });

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { files: [{ ...pdf(), name: 'copia.pdf', sha256: hash }] }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<CreateUploadsResponse>().uploads[0]?.duplicateOf).toMatchObject({
      id: first.id,
      name: 'primero.pdf',
    });
    // Nothing is warned about when the hash is new, or when the file belongs to another patient.
    const fresh = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(patientId, { files: [{ ...pdf(), sha256: 'cd'.repeat(32) }] }),
    );
    expect(fresh.json<CreateUploadsResponse>().uploads[0]?.duplicateOf).toBeNull();
    const otherPatient = await h.patient();
    const elsewhere = await h.api.post(
      '/documents/uploads',
      h.sessions.professional,
      request(otherPatient, { files: [{ ...pdf(), sha256: hash }] }),
    );
    expect(elsewhere.json<CreateUploadsResponse>().uploads[0]?.duplicateOf).toBeNull();
  });

  it('does not reveal a clinical document to reception through the duplicate warning', async () => {
    const patientId = await h.patient();
    const hash = 'ef'.repeat(32);
    const clinical = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('d2'),
    });
    await forceAvailable(runtime, h.tenant.id, clinical.id, { sha256: hash });

    const response = await h.api.post(
      '/documents/uploads',
      h.sessions.reception,
      request(patientId, { category: 'id_copy', files: [{ ...pdf(), sha256: hash }] }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<CreateUploadsResponse>().uploads[0]?.duplicateOf).toBeNull();
  });
});

describe('without object storage', () => {
  it('answers service unavailable instead of failing at startup', async () => {
    const bare = await createDocumentsHarness(runtime, 'docs-uploads-nostorage', {
      storage: undefined as never,
    });
    try {
      const patientId = await bare.patient();
      const response = await bare.api.post(
        '/documents/uploads',
        bare.sessions.professional,
        request(patientId),
      );
      expect(response.statusCode).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

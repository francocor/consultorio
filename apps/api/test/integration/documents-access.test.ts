import { randomUUID } from 'node:crypto';

import type {
  AuditAction,
  DocumentDto,
  DocumentListResponse,
  DownloadLinkResponse,
} from '@consultorio/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { actionToken } from '../../src/db/schema/action-token.js';
import { auditEvent } from '../../src/db/schema/audit.js';
import { document } from '../../src/db/schema/documents.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { minimalPdf } from '../../src/platform/files/test-files.js';
import { withScanning, type ScanningHarness } from '../support/document-scans.js';
import { asSystem, createDocumentsHarness } from '../support/documents.js';
import { asTenant } from '../support/tenants.js';

let runtime: DbHandle;
let h: ScanningHarness;
let other: ScanningHarness;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = withScanning(await createDocumentsHarness(runtime, 'docs-access'));
  other = withScanning(await createDocumentsHarness(runtime, 'docs-access-b'));
});

afterAll(async () => {
  await h.close();
  await other.close();
  await runtime.close();
});

const setReceptionMetadata = (on: boolean) =>
  asTenant(runtime, h.tenant.id, (tx) =>
    tx
      .update(tenantTable)
      .set({ settings: on ? { reception_sees_clinical_metadata: true } : {} })
      .where(eq(tenantTable.id, h.tenant.id)),
  );

/** A patient with one clinical and one administrative document, both available. */
async function patientWithDocuments() {
  const patientId = await h.patient();
  const lab = await h.upload(h.sessions.professional, {
    patientId,
    category: 'lab_result',
    name: 'laboratorio.pdf',
    bytes: minimalPdf(`lab ${randomUUID()}`),
  });
  const card = await h.upload(h.sessions.reception, {
    patientId,
    category: 'coverage_card',
    name: 'credencial.pdf',
    bytes: minimalPdf(`card ${randomUUID()}`),
  });
  await h.runScans();
  return { patientId, lab: lab.id, card: card.id };
}

type Reply = Awaited<ReturnType<typeof h.api.get>>;

const list = (patientId: string, session: Parameters<typeof h.api.get>[1], query = '') =>
  h.api.get(`/patients/${patientId}/documents${query}`, session);

const namesOf = (response: Reply) =>
  response
    .json<DocumentListResponse>()
    .documents.map((entry) => entry.name)
    .sort();

async function auditRows(action: AuditAction, patientId: string) {
  const rows = await asSystem(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.patientId === patientId);
}

describe('which documents each role sees in the list', () => {
  it('shows a treating professional every document, clinical and administrative', async () => {
    const { patientId } = await patientWithDocuments();

    const response = await list(patientId, h.sessions.professional);

    expect(response.statusCode).toBe(200);
    expect(namesOf(response)).toEqual(['credencial.pdf', 'laboratorio.pdf']);
  });

  it('shows a professional with no relationship to the patient the administrative documents only', async () => {
    const { patientId } = await patientWithDocuments();

    expect(namesOf(await list(patientId, h.sessions.colleague))).toEqual(['credencial.pdf']);
  });

  it('shows reception, the administration and the owner the administrative documents only: no trace of a clinical one', async () => {
    const { patientId } = await patientWithDocuments();

    for (const session of [h.sessions.reception, h.sessions.admin, h.sessions.owner]) {
      const response = await list(patientId, session);
      expect(namesOf(response)).toEqual(['credencial.pdf']);
      expect(JSON.stringify(response.json())).not.toContain('laboratorio');
    }
  });

  it('lets reception see the NAME and category of a clinical document when the organization allows it, and nothing else', async () => {
    const { patientId, lab } = await patientWithDocuments();
    await setReceptionMetadata(true);
    try {
      const response = await list(patientId, h.sessions.reception);

      const entry = response.json<DocumentListResponse>().documents.find((item) => item.id === lab);
      expect(entry).toMatchObject({
        name: 'laboratorio.pdf',
        category: 'lab_result',
        classification: 'clinical',
        metadataOnly: true,
      });
      // The administrative one is still a normal entry.
      expect(
        response
          .json<DocumentListResponse>()
          .documents.find((item) => item.name === 'credencial.pdf')?.metadataOnly,
      ).toBe(false);
    } finally {
      await setReceptionMetadata(false);
    }
  });

  it('never lets the administration see clinical metadata, with the setting on or off', async () => {
    const { patientId } = await patientWithDocuments();
    await setReceptionMetadata(true);
    try {
      for (const session of [h.sessions.admin, h.sessions.owner]) {
        expect(namesOf(await list(patientId, session))).toEqual(['credencial.pdf']);
      }
    } finally {
      await setReceptionMetadata(false);
    }
  });

  it('follows the setting at once: turned off, reception sees nothing clinical again', async () => {
    const { patientId } = await patientWithDocuments();

    await setReceptionMetadata(true);
    expect(namesOf(await list(patientId, h.sessions.reception))).toHaveLength(2);
    await setReceptionMetadata(false);
    expect(namesOf(await list(patientId, h.sessions.reception))).toEqual(['credencial.pdf']);
  });

  it('gives reception metadata but no way to the file: the link is refused and no token exists', async () => {
    const { lab } = await patientWithDocuments();
    await setReceptionMetadata(true);
    try {
      const before = (
        await asSystem(runtime, h.tenant.id, (tx) =>
          tx.select().from(actionToken).where(eq(actionToken.kind, 'document_download')),
        )
      ).length;

      const response = await h.api.post(`/documents/${lab}/download-link`, h.sessions.reception);

      expect(response.statusCode).toBe(403);
      const after = (
        await asSystem(runtime, h.tenant.id, (tx) =>
          tx.select().from(actionToken).where(eq(actionToken.kind, 'document_download')),
        )
      ).length;
      expect(after).toBe(before);
    } finally {
      await setReceptionMetadata(false);
    }
  });

  it('lets the administration download an administrative document and refuses a clinical one', async () => {
    const { lab, card } = await patientWithDocuments();

    const allowed = await h.api.post(`/documents/${card}/download-link`, h.sessions.admin);
    const refused = await h.api.post(`/documents/${lab}/download-link`, h.sessions.admin);

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<DownloadLinkResponse>().url).toMatch(/^\/files\//);
    expect(refused.statusCode).toBe(403);
  });
});

describe('the list itself', () => {
  it('answers not found for a patient of another organization or one that does not exist', async () => {
    const foreign = await other.patient();

    expect((await list(foreign, h.sessions.professional)).statusCode).toBe(404);
    expect((await list(randomUUID(), h.sessions.professional)).statusCode).toBe(404);
  });

  it('carries metadata only: no storage key, no hash, no content, no link', async () => {
    const { patientId } = await patientWithDocuments();

    const response = await list(patientId, h.sessions.professional);

    const keys = response
      .json<DocumentListResponse>()
      .documents.flatMap((entry) => Object.keys(entry));
    expect(new Set(keys)).toEqual(
      new Set([
        'id',
        'patientId',
        'name',
        'category',
        'classification',
        'status',
        'contentType',
        'size',
        'uploadedAt',
        'uploadedByName',
        'rejectionReason',
        'encounterId',
        'appointmentId',
        'replacesDocumentId',
        'versionCount',
        'duplicateOf',
        'hidden',
        'metadataOnly',
      ]),
    );
    expect(response.body).not.toContain('quarantine');
    expect(response.body).not.toContain('/docs/');
  });

  it('shows the uploader and a pending-scan document with its status and no way to download it', async () => {
    h.scanner.setAvailable(false);
    const patientId = await h.patient();
    const pending = await h.upload(h.sessions.reception, {
      patientId,
      category: 'id_copy',
      name: 'pendiente.pdf',
      bytes: minimalPdf('pendiente'),
    });
    await h.runScans();
    try {
      const entry = (await list(patientId, h.sessions.admin))
        .json<DocumentListResponse>()
        .documents.find((item) => item.id === pending.id);

      expect(entry).toMatchObject({
        status: 'quarantined',
        contentType: null,
        name: 'pendiente.pdf',
      });
      expect(
        (await h.api.post(`/documents/${pending.id}/download-link`, h.sessions.admin)).statusCode,
      ).toBe(409);
    } finally {
      h.scanner.setAvailable(true);
      await h.runScans();
    }
  });

  it('does not list an upload that was never confirmed, so an interrupted upload leaves nothing visible', async () => {
    const patientId = await h.patient();
    await h.api.post('/documents/uploads', h.sessions.reception, {
      patientId,
      category: 'id_copy',
      files: [{ name: 'a medias.pdf', contentType: 'application/pdf', size: 5000 }],
    });

    expect(namesOf(await list(patientId, h.sessions.reception))).toEqual([]);
    expect(namesOf(await list(patientId, h.sessions.professional))).toEqual([]);
    // The row exists for the system (the cleanup job marks it), but nobody is shown it.
    const rows = await asSystem(runtime, h.tenant.id, (tx) =>
      tx.select().from(document).where(eq(document.patientId, patientId)),
    );
    expect(rows).toHaveLength(1);
  });

  it('shows a rejected file to whoever uploaded it, with the reason, and to nobody else', async () => {
    const patientId = await h.patient();
    const rejected = await h.upload(h.sessions.reception, {
      patientId,
      category: 'id_copy',
      name: 'rechazado.pdf',
      bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]),
    });
    await h.runScans();

    const own = (await list(patientId, h.sessions.reception))
      .json<DocumentListResponse>()
      .documents.find((item) => item.id === rejected.id);
    const others = namesOf(await list(patientId, h.sessions.admin));

    expect(own).toMatchObject({ status: 'rejected', rejectionReason: 'type_not_allowed' });
    expect(others).toEqual([]);
  });
});

describe('the database repeats the rule (direct SQL as the application role)', () => {
  it('shows the metadata function to reception only when the setting is on, and never to anyone else', async () => {
    const { patientId } = await patientWithDocuments();
    const call = (userId: string) =>
      createWithTenant(runtime.db)({ tenantId: h.tenant.id, userId }, async (tx) => {
        const result = await tx.execute<{ original_name: string }>(
          sql`select original_name from app.reception_clinical_documents(${patientId}::uuid)`,
        );
        return result.rows.map((row) => row.original_name);
      });

    expect(await call(h.sessions.reception.user.id)).toEqual([]);
    await setReceptionMetadata(true);
    try {
      expect(await call(h.sessions.reception.user.id)).toEqual(['laboratorio.pdf']);
      expect(await call(h.sessions.admin.user.id)).toEqual([]);
      expect(await call(h.sessions.owner.user.id)).toEqual([]);
      expect(await call(randomUUID())).toEqual([]);
    } finally {
      await setReceptionMetadata(false);
    }
  });

  it('keeps clinical rows invisible to a plain transaction even for the metadata function of another organization', async () => {
    const { patientId } = await patientWithDocuments();

    const rows = await createWithTenant(runtime.db)(
      { tenantId: other.tenant.id, userId: other.sessions.reception.user.id },
      (tx) => tx.execute(sql`select * from app.reception_clinical_documents(${patientId}::uuid)`),
    );

    expect(rows.rows).toHaveLength(0);
  });
});

describe('reclassifying a document', () => {
  it('lets a treating professional move a document between clinical and administrative, and audits it', async () => {
    const { patientId, card } = await patientWithDocuments();

    const toClinical = await h.api.post(`/documents/${card}/reclassify`, h.sessions.professional, {
      category: 'referral',
    });

    expect(toClinical.statusCode).toBe(200);
    expect(toClinical.json<DocumentDto>()).toMatchObject({
      classification: 'clinical',
      category: 'referral',
    });
    // Now reception no longer sees it.
    expect(namesOf(await list(patientId, h.sessions.reception))).toEqual([]);
    const toAdministrative = await h.api.post(
      `/documents/${card}/reclassify`,
      h.sessions.professional,
      { category: 'signed_form' },
    );
    expect(toAdministrative.json<DocumentDto>().classification).toBe('administrative');
    expect(namesOf(await list(patientId, h.sessions.reception))).toEqual(['credencial.pdf']);
    const events = await auditRows('document.reclassified', patientId);
    expect(events).toHaveLength(2);
    expect(events[1]?.metadata).toMatchObject({ from: 'administrative', to: 'clinical' });
  });

  it('is for health professionals only, and a professional who does not treat the patient cannot make a document clinical', async () => {
    const { card, lab } = await patientWithDocuments();

    for (const session of [h.sessions.reception, h.sessions.admin, h.sessions.owner]) {
      expect(
        (await h.api.post(`/documents/${card}/reclassify`, session, { category: 'referral' }))
          .statusCode,
      ).toBe(403);
    }
    expect(
      (
        await h.api.post(`/documents/${card}/reclassify`, h.sessions.colleague, {
          category: 'referral',
        })
      ).statusCode,
    ).toBe(403);
    // A clinical document the reader cannot see cannot be reclassified by them either.
    expect(
      (
        await h.api.post(`/documents/${lab}/reclassify`, h.sessions.colleague, {
          category: 'id_copy',
        })
      ).statusCode,
    ).toBe(403);
  });
});

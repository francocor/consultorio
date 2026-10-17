import { randomUUID } from 'node:crypto';

import type {
  AuditAction,
  DocumentListResponse,
  DocumentVersionsResponse,
  DownloadLinkResponse,
} from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { document } from '../../src/db/schema/documents.js';
import { tenant as tenantTable } from '../../src/db/schema/tenant.js';
import { createDocumentCleanup } from '../../src/modules/documents/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, type Tx } from '../../src/platform/db/tenant-context.js';
import { EICAR, minimalPdf } from '../../src/platform/files/test-files.js';
import { withScanning, type ScanningHarness } from '../support/document-scans.js';
import { asSystem, createDocumentsHarness } from '../support/documents.js';
import { runPending } from '../support/jobs.js';
import { asTenant } from '../support/tenants.js';

let runtime: DbHandle;
let h: ScanningHarness;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = withScanning(await createDocumentsHarness(runtime, 'docs-lifecycle'));
});

afterAll(async () => {
  await h.close();
  await runtime.close();
});

const rowOf = async (id: string) => {
  const [row] = await asSystem(runtime, h.tenant.id, (tx) =>
    tx.select().from(document).where(eq(document.id, id)),
  );
  if (!row) throw new Error('document not found');
  return row;
};

async function auditRows(action: AuditAction, documentId: string) {
  const rows = await asSystem(runtime, h.tenant.id, (tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(and(eq(auditEvent.tenantId, h.tenant.id), eq(auditEvent.action, action)))
      .orderBy(desc(auditEvent.occurredAt)),
  );
  return rows.filter((row) => row.resourceId === documentId);
}

async function available(
  options: { patientId?: string; name?: string; text?: string; replaces?: string } = {},
) {
  const patientId = options.patientId ?? (await h.patient());
  const uploaded = await h.upload(h.sessions.professional, {
    patientId,
    category: 'lab_result',
    name: options.name ?? 'informe.pdf',
    bytes: minimalPdf(options.text ?? randomUUID()),
    ...(options.replaces === undefined ? {} : { replacesDocumentId: options.replaces }),
  });
  await h.runScans();
  return { id: uploaded.id, patientId };
}

type Reply = Awaited<ReturnType<typeof h.api.get>>;

const list = (patientId: string, query = '') =>
  h.api.get(`/patients/${patientId}/documents${query}`, h.sessions.professional);
const entries = (response: Reply) => response.json<DocumentListResponse>().documents;

describe('hiding a document uploaded by mistake', () => {
  it('removes it from the default list but keeps the file, the metadata, the reason and the actor', async () => {
    const { id, patientId } = await available({ name: 'equivocado.pdf' });

    const response = await h.api.post(`/documents/${id}/hide`, h.sessions.professional, {
      reason: 'Paciente equivocado',
    });

    expect(response.statusCode).toBe(200);
    expect(entries(await list(patientId))).toHaveLength(0);
    const shown = entries(await list(patientId, '?includeHidden=true'));
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      id,
      status: 'hidden',
      hidden: { reason: 'Paciente equivocado' },
    });
    // Nothing was removed: the row and the object are still there.
    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: 'hidden',
      hiddenBy: h.sessions.professional.user.id,
      hiddenReason: 'Paciente equivocado',
    });
    expect(h.storage.keys()).toContain(row.objectKey);
    const [event] = await auditRows('document.hidden', id);
    expect(event).toMatchObject({
      outcome: 'allow',
      actorUserId: h.sessions.professional.user.id,
      patientId,
    });
    // The reason is free text and stays out of the audit trail.
    expect(JSON.stringify(event?.metadata)).not.toContain('equivocado');
  });

  it('needs a reason, and a document that is available', async () => {
    const { id } = await available();
    const waiting = await h.upload(h.sessions.professional, {
      patientId: await h.patient(),
      category: 'lab_result',
      bytes: minimalPdf('espera'),
    });

    expect(
      (await h.api.post(`/documents/${id}/hide`, h.sessions.professional, { reason: '   ' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await h.api.post(`/documents/${id}/hide`, h.sessions.professional, {})).statusCode,
    ).toBe(400);
    expect(
      (await h.api.post(`/documents/${waiting.id}/hide`, h.sessions.professional, { reason: 'x' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await h.api.post(`/documents/${id}/hide`, h.sessions.professional, { reason: 'ok' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await h.api.post(`/documents/${id}/hide`, h.sessions.professional, { reason: 'ok' }))
        .statusCode,
    ).toBe(409);
    await h.runScans();
  });

  it('follows the classification: reception hides an administrative document and is refused a clinical one', async () => {
    const patientId = await h.patient();
    const card = await h.upload(h.sessions.reception, {
      patientId,
      category: 'id_copy',
      bytes: minimalPdf('dni'),
    });
    await h.runScans();
    const lab = await available({ patientId });

    expect(
      (await h.api.post(`/documents/${lab.id}/hide`, h.sessions.reception, { reason: 'x' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await h.api.post(`/documents/${lab.id}/hide`, h.sessions.admin, { reason: 'x' })).statusCode,
    ).toBe(403);
    expect(
      (await h.api.post(`/documents/${card.id}/hide`, h.sessions.reception, { reason: 'x' }))
        .statusCode,
    ).toBe(200);
  });

  it('cannot be undone through the API, and a document cannot be deleted by anyone', async () => {
    const { id } = await available();

    for (const session of Object.values(h.sessions)) {
      expect((await h.api.delete(`/documents/${id}`, session)).statusCode).toBe(404);
    }
    expect((await rowOf(id)).status).toBe('available');
  });
});

describe('uploading a corrected version', () => {
  it('shows only the latest version in the list, and keeps the previous one reachable', async () => {
    const first = await available({ name: 'lab-2026-10.pdf', text: 'version 1' });
    const second = await available({
      patientId: first.patientId,
      name: 'lab-2026-10.pdf',
      text: 'version 2',
      replaces: first.id,
    });

    const shown = entries(await list(first.patientId));

    expect(shown.map((entry) => entry.id)).toEqual([second.id]);
    expect(shown[0]).toMatchObject({ versionCount: 2, replacesDocumentId: first.id });
    const versions = await h.api.get(`/documents/${second.id}/versions`, h.sessions.professional);
    expect(versions.json<DocumentVersionsResponse>().versions.map((entry) => entry.id)).toEqual([
      second.id,
      first.id,
    ]);
    // The original is retained and still downloadable.
    const link = await h.api.post(`/documents/${first.id}/download-link`, h.sessions.professional);
    expect(link.statusCode).toBe(200);
    expect(link.json<DownloadLinkResponse>().url).toMatch(/^\/files\//);
    expect((await rowOf(first.id)).status).toBe('available');
  });

  it('keeps the previous version as the latest while the new one is still being scanned or was refused', async () => {
    const first = await available({ text: 'original' });
    const refused = await h.upload(h.sessions.professional, {
      patientId: first.patientId,
      category: 'lab_result',
      bytes: Buffer.from(`%PDF-1.4\n% ${EICAR}\n%%EOF\n`),
      replacesDocumentId: first.id,
    });
    // While the new file waits for its scan, the previous version is still the latest one.
    const pending = entries(await list(first.patientId));
    expect(pending.find((entry) => entry.id === first.id)).toMatchObject({
      status: 'available',
      versionCount: 1,
    });
    expect(pending.find((entry) => entry.id === refused.id)?.status).toBe('quarantined');

    await h.runScans();

    const after = entries(await list(first.patientId));
    expect(after.find((entry) => entry.id === first.id)?.status).toBe('available');
    expect(after.find((entry) => entry.id === refused.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'infected',
    });
    expect((await rowOf(refused.id)).status).toBe('rejected');
    // The refused replacement does not block the next attempt.
    const retry = await h.api.post('/documents/uploads', h.sessions.professional, {
      patientId: first.patientId,
      category: 'lab_result',
      replacesDocumentId: first.id,
      files: [{ name: 'otra.pdf', contentType: 'application/pdf', size: 3000 }],
    });
    expect(retry.statusCode).toBe(200);
  });

  it('answers not found for the versions of a document of another patient organization or one that is invisible', async () => {
    const { id } = await available();

    expect((await h.api.get(`/documents/${id}/versions`, h.sessions.colleague)).statusCode).toBe(
      403,
    );
    expect(
      (await h.api.get(`/documents/${randomUUID()}/versions`, h.sessions.professional)).statusCode,
    ).toBe(404);
  });
});

describe('a copy of a file that is already on the patient', () => {
  it('is kept, and is marked as a duplicate of the first one', async () => {
    const first = await available({ text: 'igual' });
    const copy = await available({ patientId: first.patientId, text: 'igual', name: 'copia.pdf' });

    const shown = entries(await list(first.patientId));

    expect(shown.find((entry) => entry.id === copy.id)?.duplicateOf).toMatchObject({
      id: first.id,
    });
    expect(shown.find((entry) => entry.id === first.id)?.duplicateOf).toBeNull();
    expect(shown).toHaveLength(2);
  });
});

/** Queues the cleanup of the organization the way the hourly tick does (the recording queue ignores the transaction). */
const queueCleanup = () =>
  h.jobs.enqueue(undefined as unknown as Tx, 'document.cleanup', { tenantId: h.tenant.id });

describe('cleaning up uploads nobody finished', () => {
  const cleanupAt = (later: Date) =>
    createDocumentCleanup({
      storage: h.storage,
      jobs: h.jobs,
      clock: () => later,
    });
  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

  it('marks an upload that was never confirmed as abandoned, removes its orphan object and keeps the row', async () => {
    const patientId = await h.patient();
    const created = await h.api.post('/documents/uploads', h.sessions.reception, {
      patientId,
      category: 'id_copy',
      files: [{ name: 'a medias.pdf', contentType: 'application/pdf', size: 5000 }],
    });
    const { id, upload } = created.json<{
      uploads: { id: string; upload: { fields: Record<string, string> } }[];
    }>().uploads[0] ?? {
      id: '',
      upload: { fields: {} },
    };
    await h.storage.put(h.tenant.id, upload.fields['key'] ?? '', {
      body: minimalPdf('huérfano'),
      contentType: 'application/pdf',
    });
    const cleanup = cleanupAt(hoursFromNow(25));
    await queueCleanup();

    await runPending(runtime.db, h.jobs, [cleanup]);

    const row = await rowOf(id);
    expect(row.abandonedAt).toBeInstanceOf(Date);
    expect(row.status).toBe('quarantined');
    expect(h.storage.keys().filter((key) => key.includes(id))).toEqual([]);
  });

  it('leaves alone an upload that is recent, one that was confirmed, and any document that is available', async () => {
    const patientId = await h.patient();
    await h.api.post('/documents/uploads', h.sessions.reception, {
      patientId,
      category: 'id_copy',
      files: [{ name: 'reciente.pdf', contentType: 'application/pdf', size: 5000 }],
    });
    const confirmed = await available({ patientId });
    await queueCleanup();

    await runPending(runtime.db, h.jobs, [cleanupAt(hoursFromNow(1))]);

    const rows = await asSystem(runtime, h.tenant.id, (tx) =>
      tx.select().from(document).where(eq(document.patientId, patientId)),
    );
    expect(rows.every((row) => row.abandonedAt === null)).toBe(true);
    expect((await rowOf(confirmed.id)).status).toBe('available');
  });

  it('queues the scan again for a confirmed upload whose job was lost', async () => {
    const patientId = await h.patient();
    const lost = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('perdido'),
    });
    // The queued scan is lost: nothing will ever run it.
    for (const job of h.jobs.pending('document.scan')) job.done = true;
    const before = h.jobs.pending('document.scan').length;
    await queueCleanup();

    await runPending(runtime.db, h.jobs, [cleanupAt(hoursFromNow(2))]);

    const queued = h.jobs.pending('document.scan');
    expect(queued.length).toBe(before + 1);
    expect(queued.at(-1)?.payload).toMatchObject({ documentId: lost.id });
    await h.runScans();
    expect((await rowOf(lost.id)).status).toBe('available');
  });
});

describe('a colleague who reads a clinical document only through sharing (JD-S2 C2)', () => {
  const setSharing = (on: boolean) =>
    asTenant(runtime, h.tenant.id, (tx) =>
      tx
        .update(tenantTable)
        .set({ settings: on ? { clinicalSharing: true, sharedTemplates: ['general'] } : {} })
        .where(eq(tenantTable.id, h.tenant.id)),
    );

  it('can read the document but can neither hide it nor reclassify it', async () => {
    const { id, patientId } = await available();
    await setSharing(true);
    try {
      // The colleague really reads it: the premise of the attack.
      const seen = entries(
        await h.api.get(`/patients/${patientId}/documents`, h.sessions.colleague),
      );
      expect(seen.map((entry) => entry.id)).toContain(id);

      const hide = await h.api.post(`/documents/${id}/hide`, h.sessions.colleague, { reason: 'x' });
      const toAdministrative = await h.api.post(
        `/documents/${id}/reclassify`,
        h.sessions.colleague,
        { category: 'id_copy' },
      );
      const withinClinical = await h.api.post(`/documents/${id}/reclassify`, h.sessions.colleague, {
        category: 'referral',
      });

      expect(hide.statusCode).toBe(403);
      expect(toAdministrative.statusCode).toBe(403);
      expect(withinClinical.statusCode).toBe(403);
      expect(await rowOf(id)).toMatchObject({
        status: 'available',
        classification: 'clinical',
        category: 'lab_result',
      });
    } finally {
      await setSharing(false);
    }
  });

  it('still lets the author, who is also treating, hide and reclassify', async () => {
    const hidden = await available();
    const moved = await available();

    expect(
      (await h.api.post(`/documents/${hidden.id}/hide`, h.sessions.professional, { reason: 'x' }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await h.api.post(`/documents/${moved.id}/reclassify`, h.sessions.professional, {
          category: 'referral',
        })
      ).statusCode,
    ).toBe(200);
  });

  it('is refused by the database too: a reclassification away from clinical needs the author or a treating professional', async () => {
    const { id } = await available();
    const asProfessional = (professionalId: string) =>
      createWithTenant(runtime.db)(
        {
          tenantId: h.tenant.id,
          userId: randomUUID(),
          actingProfessionalId: professionalId,
        },
        (tx) =>
          tx
            .update(document)
            .set({ classification: 'administrative', category: 'id_copy' })
            .where(eq(document.id, id))
            .returning({ id: document.id }),
      );
    await setSharing(true);
    try {
      await expect(asProfessional(h.colleagueId)).rejects.toThrow();
      expect((await rowOf(id)).classification).toBe('clinical');

      expect(await asProfessional(h.professionalId)).toHaveLength(1);
      expect((await rowOf(id)).classification).toBe('administrative');
    } finally {
      await setSharing(false);
    }
  });
});

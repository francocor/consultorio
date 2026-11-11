import { createHash, randomUUID } from 'node:crypto';

import type { AuditAction } from '@consultorio/contracts';
import { DOCUMENT_MAX_BYTES } from '@consultorio/contracts';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';

import { auditEvent } from '../../src/db/schema/audit.js';
import { document } from '../../src/db/schema/documents.js';
import { createDocumentJobs } from '../../src/modules/documents/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import type { Tx } from '../../src/platform/db/tenant-context.js';
import {
  EICAR,
  buildZip,
  minimalDocx,
  minimalJpeg,
  minimalPdf,
  minimalPng,
  minimalWebp,
} from '../../src/platform/files/test-files.js';
import type { MalwareScanner } from '../../src/platform/scanning/malware-scanner.js';
import { withScanning, type ScanningHarness } from '../support/document-scans.js';
import { asSystem, createDocumentsHarness } from '../support/documents.js';
import { runPending } from '../support/jobs.js';

let runtime: DbHandle;
let h: ScanningHarness;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  h = withScanning(await createDocumentsHarness(runtime, 'docs-scan'));
});

// A test that fails while the scanner is switched off must not leave it off for the next ones.
afterEach(() => {
  h.scanner.setAvailable(true);
});

afterAll(async () => {
  await h.close();
  await runtime.close();
});

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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

/** Queues a scan the way a confirmed upload does (the recording queue ignores the transaction). */
const enqueueScan = (documentId: string) =>
  h.jobs.enqueue(undefined as unknown as Tx, 'document.scan', {
    tenantId: h.tenant.id,
    documentId,
  });

/** Uploads one file as the treating professional, scans it, and returns the row. */
async function uploadAndScan(
  bytes: Buffer,
  options: { category?: 'lab_result' | 'id_copy'; contentType?: string; name?: string } = {},
) {
  const patientId = await h.patient();
  const uploaded = await h.upload(
    options.category === 'id_copy' ? h.sessions.reception : h.sessions.professional,
    {
      patientId,
      category: options.category ?? 'lab_result',
      bytes,
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      ...(options.name === undefined ? {} : { name: options.name }),
    },
  );
  await h.runScans();
  return { id: uploaded.id, patientId, row: await rowOf(uploaded.id) };
}

describe('a clean file', () => {
  it('becomes available with its hash and detected type, and moves out of quarantine', async () => {
    const bytes = minimalPdf('informe limpio');

    const { id, row } = await uploadAndScan(bytes);

    expect(row).toMatchObject({
      status: 'available',
      sha256: sha256(bytes),
      contentType: 'application/pdf',
      scanResult: 'clean',
      rejectionReason: null,
      objectKey: `t/${h.tenant.id}/docs/${id}`,
    });
    expect(row.scannedAt).toBeInstanceOf(Date);
    // The object lives under the docs prefix now, and no longer under quarantine.
    expect(h.storage.keys()).toContain(`t/${h.tenant.id}/docs/${id}`);
    expect(h.storage.keys()).not.toContain(`t/${h.tenant.id}/quarantine/${id}`);
    expect(h.notices.filter((notice) => notice.documentId === id)).toEqual([]);
  });

  it.each([
    ['a JPEG', minimalJpeg(), 'image/jpeg'],
    ['a PNG', minimalPng(), 'image/png'],
    ['a WebP', minimalWebp(), 'image/webp'],
    [
      'a DOCX',
      minimalDocx(),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['plain text', Buffer.from('Indicaciones: reposo e hidratación.'), 'text/plain'],
  ])('releases %s with the type its content has', async (_name, bytes, contentType) => {
    const { row } = await uploadAndScan(bytes, { contentType, category: 'id_copy' });

    expect(row).toMatchObject({ status: 'available', contentType, sha256: sha256(bytes) });
  });

  it('writes one audit entry for the scan without the file name or the content', async () => {
    const { id } = await uploadAndScan(minimalPdf('auditado'), { name: 'secreto-nombre.pdf' });

    const [event] = await auditRows('document.scanned', id);

    expect(event).toMatchObject({ outcome: 'allow', resourceType: 'document', actorUserId: null });
    expect(event?.metadata).toMatchObject({ result: 'clean' });
    expect(JSON.stringify(event?.metadata)).not.toContain('secreto');
  });

  it('marks a second copy of the same content as a duplicate of the first, and keeps both', async () => {
    const patientId = await h.patient();
    const bytes = minimalPdf('mismo contenido');
    const first = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes,
    });
    await h.runScans();
    const second = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes,
    });
    await h.runScans();

    expect((await rowOf(first.id)).duplicateOfId).toBeNull();
    expect(await rowOf(second.id)).toMatchObject({ status: 'available', duplicateOfId: first.id });
  });
});

describe('an infected file', () => {
  it('is rejected, never offered, its object removed, and the uploader is told', async () => {
    const bytes = Buffer.from(`%PDF-1.4\n% ${EICAR}\n%%EOF\n`);

    const { id, row } = await uploadAndScan(bytes);

    expect(row).toMatchObject({
      status: 'rejected',
      rejectionReason: 'infected',
      scanResult: 'infected',
      sha256: null,
    });
    expect(h.storage.keys().filter((key) => key.includes(id))).toEqual([]);
    expect(h.notices.find((notice) => notice.documentId === id)).toMatchObject({
      tenantId: h.tenant.id,
      uploaderUserId: h.sessions.professional.user.id,
      reason: 'infected',
    });
    const [event] = await auditRows('document.scanned', id);
    expect(event?.metadata).toMatchObject({ result: 'rejected', reason: 'infected' });
  });
});

describe('a file that is not what it says', () => {
  it('rejects a renamed executable by its content, without asking the scanner', async () => {
    const scansBefore = h.scanner.scans();
    const executable = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(300, 0x90)]);

    const { id, row } = await uploadAndScan(executable, { name: 'scan.pdf' });

    expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'type_not_allowed' });
    expect(h.scanner.scans()).toBe(scansBefore);
    expect(h.storage.keys().filter((key) => key.includes(id))).toEqual([]);
    expect(h.notices.find((notice) => notice.documentId === id)?.reason).toBe('type_not_allowed');
  });

  it('rejects a script, an archive and an unrecognized binary as a type that is not allowed', async () => {
    for (const bytes of [
      Buffer.from('#!/bin/sh\nrm -rf /\n'),
      buildZip([{ name: 'a.txt', data: Buffer.from('x') }]),
      Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    ]) {
      const { row } = await uploadAndScan(bytes, {
        contentType: 'text/plain',
        category: 'id_copy',
      });
      expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'type_not_allowed' });
    }
  });

  it('rejects a declared type that differs from the real one', async () => {
    const { row } = await uploadAndScan(minimalPdf('es un pdf'), {
      contentType: 'image/png',
      category: 'id_copy',
    });

    expect(row).toMatchObject({ status: 'rejected', rejectionReason: 'type_mismatch' });
  });

  it('rejects a polyglot and a damaged file as corrupt', async () => {
    const polyglot = Buffer.concat([
      minimalPdf('poliglota'),
      buildZip([{ name: 'p.exe', data: Buffer.from('MZ') }]),
    ]);
    const truncated = minimalPdf('roto').subarray(0, 14);

    expect((await uploadAndScan(polyglot)).row).toMatchObject({
      status: 'rejected',
      rejectionReason: 'corrupt',
    });
    expect((await uploadAndScan(truncated)).row).toMatchObject({
      status: 'rejected',
      rejectionReason: 'corrupt',
    });
  });

  it('rejects an object that grew past the cap after it was confirmed, without reading all of it', async () => {
    const patientId = await h.patient();
    const uploaded = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('chico'),
    });
    await h.storage.put(h.tenant.id, `t/${h.tenant.id}/quarantine/${uploaded.id}`, {
      body: Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 0x41),
      contentType: 'application/pdf',
    });

    await h.runScans();

    expect(await rowOf(uploaded.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'too_large',
    });
  });

  it('rejects a document whose object has vanished, instead of leaving it in quarantine forever', async () => {
    const patientId = await h.patient();
    const uploaded = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('desaparece'),
    });
    await h.storage.remove(h.tenant.id, `t/${h.tenant.id}/quarantine/${uploaded.id}`);

    await h.runScans();

    expect(await rowOf(uploaded.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'corrupt',
    });
  });
});

describe('when the scanner cannot be reached (fail closed)', () => {
  it('keeps the document quarantined, tries again later with a growing delay, and releases it once scanned', async () => {
    h.scanner.setAvailable(false);
    const patientId = await h.patient();
    const bytes = minimalPdf('espera al escaner');
    const uploaded = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes,
    });

    await h.runScans();
    const first = await rowOf(uploaded.id);
    const retryOne = h.jobs.pending('document.scan').at(-1);
    await h.runScans();
    const second = await rowOf(uploaded.id);
    const retryTwo = h.jobs.pending('document.scan').at(-1);

    // Never released, never rejected, and not downloadable: it simply waits.
    expect(first).toMatchObject({ status: 'quarantined', scanAttempts: 1, sha256: null });
    expect(first.lastScanErrorAt).toBeInstanceOf(Date);
    expect(second).toMatchObject({ status: 'quarantined', scanAttempts: 2 });
    expect(h.storage.keys()).toContain(`t/${h.tenant.id}/quarantine/${uploaded.id}`);
    expect(retryOne?.options.startAfter).toBe(30);
    expect(retryTwo?.options.startAfter).toBe(60);
    expect(await auditRows('document.scanned', uploaded.id)).toHaveLength(0);

    h.scanner.setAvailable(true);
    await h.runScans();

    expect(await rowOf(uploaded.id)).toMatchObject({
      status: 'available',
      sha256: sha256(bytes),
      scanAttempts: 2,
    });
  });

  it('raises an alert once the document has waited more than an hour, and not before', async () => {
    h.scanner.setAvailable(false);
    const fresh = await uploadAndScan(minimalPdf('reciente'));
    const stale = await uploadAndScan(minimalPdf('vieja'));
    // The job reads the clock of this process, so the age is set from the same clock: the database
    // clock (inside a container) may be a few seconds apart from the host's.
    const staleSince = new Date(Date.now() - 61 * 60_000);
    await asSystem(runtime, h.tenant.id, (tx) =>
      tx.update(document).set({ uploadCompletedAt: staleSince }).where(eq(document.id, stale.id)),
    );
    h.alerts.length = 0;

    // Both were already tried once above; one more round with the scanner still down.
    await h.runScans();

    expect(h.alerts.map((alert) => alert.documentId)).toEqual([stale.id]);
    expect(h.alerts[0]).toMatchObject({ tenantId: h.tenant.id });
    expect(h.alerts[0]?.waitingMinutes).toBeGreaterThanOrEqual(61);
    expect(h.alerts.some((alert) => alert.documentId === fresh.id)).toBe(false);
    h.scanner.setAvailable(true);
    await h.runScans();
  });
});

describe('a scan that runs twice, or after a crash', () => {
  it('does nothing the second time: one audit entry, no new scan, the same state', async () => {
    const { id } = await uploadAndScan(minimalPdf('una vez'));
    const scans = h.scanner.scans();
    await enqueueScan(id);

    await h.runScans();

    expect(h.scanner.scans()).toBe(scans);
    expect(await auditRows('document.scanned', id)).toHaveLength(1);
    expect((await rowOf(id)).status).toBe('available');
  });

  it('finishes a release whose object was already moved before the previous attempt failed', async () => {
    const patientId = await h.patient();
    const bytes = minimalPdf('movido');
    const uploaded = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes,
    });
    await h.storage.move(
      h.tenant.id,
      `t/${h.tenant.id}/quarantine/${uploaded.id}`,
      `t/${h.tenant.id}/docs/${uploaded.id}`,
    );

    await h.runScans();

    expect(await rowOf(uploaded.id)).toMatchObject({
      status: 'available',
      sha256: sha256(bytes),
      objectKey: `t/${h.tenant.id}/docs/${uploaded.id}`,
    });
  });

  it('ignores a job for a document that does not exist or is not in this organization', async () => {
    await enqueueScan(randomUUID());
    const scans = h.scanner.scans();

    await h.runScans();

    expect(h.scanner.scans()).toBe(scans);
  });
});

describe('a file replaced between the scan and the release (JD-S2 C5)', () => {
  it('is never released as the clean file it replaced: the move waits for the same object, and the new content is scanned again', async () => {
    const patientId = await h.patient();
    const uploaded = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('limpio al escanear'),
    });
    const quarantineKey = `t/${h.tenant.id}/quarantine/${uploaded.id}`;
    const infected = Buffer.from(`%PDF-1.4\n% ${EICAR}\n%%EOF\n`);
    // The presigned link is valid for 15 minutes: the uploader overwrites the quarantined object
    // while the scanner is answering "clean" about the old bytes.
    const racing: MalwareScanner = {
      async scan() {
        await h.storage.put(h.tenant.id, quarantineKey, {
          body: infected,
          contentType: 'application/pdf',
        });
        return { status: 'clean' };
      },
    };
    const racingJobs = createDocumentJobs({
      storage: h.storage,
      scanner: racing,
      jobs: h.jobs,
      clock: () => new Date(),
    });

    await runPending(h.runtime.db, h.jobs, [racingJobs.scan]);

    // Not released: still quarantined, nothing under the docs key, and another scan is queued.
    expect(await rowOf(uploaded.id)).toMatchObject({ status: 'quarantined', sha256: null });
    expect(h.storage.keys()).not.toContain(`t/${h.tenant.id}/docs/${uploaded.id}`);
    expect(h.storage.keys()).toContain(quarantineKey);
    expect(h.jobs.pending('document.scan').length).toBeGreaterThan(0);

    // The next attempt scans what is really there.
    await h.runScans();

    expect(await rowOf(uploaded.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'infected',
    });
    expect(h.storage.keys().filter((key) => key.includes(uploaded.id))).toEqual([]);
  });

  it('gives up after a few scans of a file that keeps changing, rejects it as corrupt and raises the alarm (JD-S2 R2-C3)', async () => {
    const patientId = await h.patient();
    const uploaded = await h.upload(h.sessions.professional, {
      patientId,
      category: 'lab_result',
      bytes: minimalPdf('cambia siempre'),
    });
    const quarantineKey = `t/${h.tenant.id}/quarantine/${uploaded.id}`;
    // Someone overwrites the object during every single scan, so no attempt can ever release it.
    let swaps = 0;
    const always: MalwareScanner = {
      async scan() {
        swaps += 1;
        await h.storage.put(h.tenant.id, quarantineKey, {
          body: minimalPdf(`otra version ${String(swaps)}`),
          contentType: 'application/pdf',
        });
        return { status: 'clean' };
      },
    };
    const racingJobs = createDocumentJobs({
      storage: h.storage,
      scanner: always,
      jobs: h.jobs,
      clock: () => new Date(),
      alert: (alert) => {
        h.alerts.push(alert);
      },
    });
    h.alerts.length = 0;

    for (let round = 0; round < 12; round += 1) {
      await runPending(h.runtime.db, h.jobs, [racingJobs.scan]);
    }

    expect(await rowOf(uploaded.id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'corrupt',
    });
    // The first scan and five more; the sixth swap is the last.
    expect(swaps).toBe(6);
    expect(h.alerts.map((alert) => alert.documentId)).toEqual([uploaded.id]);
    expect(h.storage.keys().filter((key) => key.includes(uploaded.id))).toEqual([]);
    expect(h.jobs.pending('document.scan')).toEqual([]);
  });
});

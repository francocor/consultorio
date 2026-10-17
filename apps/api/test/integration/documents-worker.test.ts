import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeEmailSender } from '../../src/adapters/fake-email/index.js';
import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import { createMemoryObjectStorage } from '../../src/adapters/memory-storage/index.js';
import { document } from '../../src/db/schema/documents.js';
import { documentWorker } from '../../src/main/document-jobs.js';
import { SCAN_JOB } from '../../src/modules/documents/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';
import { EICAR, minimalPdf } from '../../src/platform/files/test-files.js';
import { createBoss, createJobClient } from '../../src/platform/jobs/boss.js';
import { startWorker, type Worker } from '../../src/platform/jobs/worker.js';
import { asSystem } from '../support/documents.js';
import { eventually } from '../support/eventually.js';
import { createTestPatient } from '../support/patients.js';
import { createTestTenant, type TestTenant } from '../support/tenants.js';
import { createTestUser } from '../support/users.js';

/**
 * The scan end to end on the real job queue (pg-boss): a confirmed upload is picked up by the
 * worker with no help from the test, and the outcome reaches the database and the uploader.
 */
let runtime: DbHandle;
let tenant: TestTenant;
let worker: Worker;
let uploaderId: string;
let uploaderEmail: string;
let patientId: string;
const storage = createMemoryObjectStorage();
const scanner = createFakeScanner();
const email = createFakeEmailSender();
const alerts: unknown[] = [];
const boss = createBoss(inject('runtimeUrl'), 'api');
const jobs = createJobClient(boss);

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  tenant = await createTestTenant(runtime, { slug: 'docs-worker' });
  const uploader = await createTestUser(runtime, tenant.id, { roles: ['reception'] });
  uploaderId = uploader.id;
  uploaderEmail = uploader.email;
  patientId = await createTestPatient(runtime, tenant.id);
  await boss.start();
  worker = await startWorker({
    databaseUrl: inject('runtimeUrl'),
    sealerDatabaseUrl: inject('sealerUrl'),
    log: { info: () => undefined, error: (object) => alerts.push(object) },
    pollingIntervalSeconds: 0.5,
    ...documentWorker({ storage, scanner, email }),
  });
}, 60_000);

afterAll(async () => {
  await worker.stop();
  await boss.stop({ graceful: false });
  await runtime.close();
});

/** A confirmed upload: the row, the object under quarantine, and the queued scan, in one go. */
async function confirmedUpload(bytes: Buffer): Promise<string> {
  const id = uuidv7();
  const objectKey = `t/${tenant.id}/quarantine/${id}`;
  await storage.put(tenant.id, objectKey, { body: bytes, contentType: 'application/pdf' });
  await asSystem(runtime, tenant.id, async (tx) => {
    await tx.insert(document).values({
      id,
      tenantId: tenant.id,
      patientId,
      category: 'id_copy',
      classification: 'administrative',
      originalName: 'informe.pdf',
      declaredContentType: 'application/pdf',
      sizeBytes: bytes.length,
      objectKey,
      uploadedBy: uploaderId,
      uploadCompletedAt: new Date(),
    });
    await jobs.enqueue(tx, SCAN_JOB, { tenantId: tenant.id, documentId: id });
  });
  return id;
}

const statusOf = async (id: string) => {
  const [row] = await asSystem(runtime, tenant.id, (tx) =>
    tx.select().from(document).where(eq(document.id, id)),
  );
  return row;
};

describe('the worker scans documents by itself', () => {
  it('releases a clean file', async () => {
    const id = await confirmedUpload(minimalPdf('limpio'));

    await eventually(
      async () => ((await statusOf(id))?.status === 'available' ? true : undefined),
      30_000,
    );

    expect((await statusOf(id))?.objectKey).toBe(`t/${tenant.id}/docs/${id}`);
  });

  it('refuses an infected file and emails the uploader', async () => {
    const id = await confirmedUpload(Buffer.from(`%PDF-1.4\n% ${EICAR}\n%%EOF\n`));

    await eventually(
      async () => ((await statusOf(id))?.status === 'rejected' ? true : undefined),
      30_000,
    );

    expect((await statusOf(id))?.rejectionReason).toBe('infected');
    const message = email.lastTo(uploaderEmail);
    expect(message?.subject).toBe('Un archivo no pudo cargarse en docs-worker');
    expect(message?.text).toContain('software malicioso');
  });

  it('leaves a file quarantined while the scanner is down, and counts the attempt', async () => {
    scanner.setAvailable(false);
    try {
      const id = await confirmedUpload(minimalPdf('espera'));

      await eventually(
        async () => (((await statusOf(id))?.scanAttempts ?? 0) >= 1 ? true : undefined),
        30_000,
      );

      expect((await statusOf(id))?.status).toBe('quarantined');
    } finally {
      scanner.setAvailable(true);
    }
  });
});

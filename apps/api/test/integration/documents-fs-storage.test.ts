import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  CreateUploadsResponse,
  DocumentDto,
  DownloadLinkResponse,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createFakeScanner } from '../../src/adapters/fake-scanner/index.js';
import {
  createFsObjectStorage,
  type FsObjectStorage,
} from '../../src/adapters/fs-storage/index.js';
import { document } from '../../src/db/schema/documents.js';
import { createDocumentJobs, type DocumentJobs } from '../../src/modules/documents/index.js';
import { createRuntimeDb, type DbHandle } from '../../src/platform/db/pool.js';
import { EICAR, minimalPdf } from '../../src/platform/files/test-files.js';
import { tenantKey } from '../../src/platform/storage/object-storage.js';
import { browserHeaders } from '../support/app.js';
import { asSystem, createDocumentsHarness, type DocumentsHarness } from '../support/documents.js';
import { multipartBody } from '../support/fs-upload.js';
import { runPending } from '../support/jobs.js';

/**
 * The document flow of the desktop profile against the real application and a real database, with
 * the files on a disk: the browser asks for an upload, POSTs the file to the same-origin link, confirms
 * it, the worker scans it and releases it out of quarantine, and the file is downloaded through the API.
 * Nothing but the storage differs from the hosted flow of `documents-lifecycle.test.ts`.
 */
const SECRET = 'placeholder-upload-secret-0123456789-abcdef';
const SLUG = 'docs-fs';

let runtime: DbHandle;
let dir: string;
let storage: FsObjectStorage;
let h: DocumentsHarness;
let other: DocumentsHarness;
let jobs: DocumentJobs;

beforeAll(async () => {
  runtime = createRuntimeDb(inject('runtimeUrl'));
  dir = await mkdtemp(join(tmpdir(), 'consulvia-docs-fs-'));
  storage = createFsObjectStorage({ dir, uploadSecret: SECRET });
  h = await createDocumentsHarness(runtime, SLUG, {
    storage,
    uploadReceiver: storage.uploads,
  });
  other = await createDocumentsHarness(runtime, `${SLUG}-b`);
  jobs = createDocumentJobs({
    storage,
    scanner: createFakeScanner(),
    jobs: h.jobs,
    clock: () => new Date(),
  });
});

afterAll(async () => {
  await h.close();
  await other.close();
  await runtime.close();
  await rm(dir, { recursive: true, force: true });
});

/** Every file the storage holds, as a key relative to its folder. */
async function storedKeys(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (folder: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(folder, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.obj')) found.push(`${prefix}${entry.name.slice(0, -4)}`);
    }
  };
  await walk(dir, '');
  return found.sort();
}

/** The browser's side of the upload, against the link the API handed out. */
async function upload(bytes: Buffer, host = SLUG) {
  const session = h.sessions.professional;
  const patientId = await h.patient();
  const created = await h.api.post('/documents/uploads', session, {
    patientId,
    category: 'lab_result',
    files: [{ name: 'resultado.pdf', contentType: 'application/pdf', size: bytes.length }],
  });
  expect(created.statusCode).toBe(200);
  const first = created.json<CreateUploadsResponse>().uploads[0];
  if (!first) throw new Error('no upload was created');

  const form = await multipartBody(Object.entries(first.upload.fields), [
    { bytes, type: 'application/pdf' },
  ]);
  const posted = await h.app.inject({
    method: 'POST',
    // The reverse proxy strips `/api` before the request reaches the API.
    url: first.upload.url.replace(/^\/api/, ''),
    headers: { ...browserHeaders(host), ...form.headers },
    remoteAddress: '10.99.0.1',
    payload: form.payload,
  });
  return { id: first.id, url: first.upload.url, posted, patientId };
}

const rowOf = async (id: string) => {
  const [row] = await asSystem(runtime, h.tenant.id, (tx) =>
    tx.select().from(document).where(eq(document.id, id)),
  );
  if (!row) throw new Error('document not found');
  return row;
};

const runScans = () => runPending(runtime.db, h.jobs, [jobs.scan]);

describe('a document on the filesystem storage', () => {
  it('is uploaded to the same-origin link, confirmed, scanned, released and downloaded', async () => {
    const bytes = minimalPdf('resultado de laboratorio');

    const { id, url, posted } = await upload(bytes);

    expect(url).toMatch(/^\/api\/files\/uploads\//);
    expect(posted.statusCode).toBe(204);
    expect(await storedKeys()).toContain(tenantKey(h.tenant.id, 'quarantine', id));

    const confirmed = await h.api.post(`/documents/${id}/uploaded`, h.sessions.professional);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json<DocumentDto>()).toMatchObject({ status: 'quarantined' });

    await runScans();

    expect(await rowOf(id)).toMatchObject({ status: 'available', scanResult: 'clean' });
    const keys = await storedKeys();
    expect(keys).toContain(tenantKey(h.tenant.id, 'docs', id));
    expect(keys).not.toContain(tenantKey(h.tenant.id, 'quarantine', id));

    const link = await h.api.post(`/documents/${id}/download-link`, h.sessions.professional);
    expect(link.statusCode).toBe(200);
    const file = await h.api.get(link.json<DownloadLinkResponse>().url, h.sessions.professional);
    expect(file.statusCode).toBe(200);
    expect(file.rawPayload.equals(bytes)).toBe(true);
    expect(file.headers['content-type']).toBe('application/pdf');
  });

  it('is refused and removed when the scanner finds a virus in it', async () => {
    const infected = Buffer.from(`%PDF-1.4\n% ${EICAR}\n%%EOF\n`);

    const { id, posted } = await upload(infected);
    expect(posted.statusCode).toBe(204);
    await h.api.post(`/documents/${id}/uploaded`, h.sessions.professional);
    await runScans();

    expect(await rowOf(id)).toMatchObject({ status: 'rejected', rejectionReason: 'infected' });
    expect(await storedKeys()).not.toContain(tenantKey(h.tenant.id, 'quarantine', id));
    expect(await storedKeys()).not.toContain(tenantKey(h.tenant.id, 'docs', id));
  });

  it('is not released when the object was swapped after it was scanned', async () => {
    const bytes = minimalPdf('limpio');
    const { id } = await upload(bytes);
    await h.api.post(`/documents/${id}/uploaded`, h.sessions.professional);
    const quarantine = tenantKey(h.tenant.id, 'quarantine', id);
    const scanned = await storage.get(h.tenant.id, quarantine);

    // The uploader still holds a valid link for 15 minutes: the object changes after the scan read it.
    await storage.put(h.tenant.id, quarantine, {
      body: Buffer.from(`%PDF-1.4\n% ${EICAR}\n%%EOF\n`),
      contentType: 'application/pdf',
    });

    await expect(
      storage.move(h.tenant.id, quarantine, tenantKey(h.tenant.id, 'docs', id), {
        ifMatch: scanned?.etag ?? '',
      }),
    ).rejects.toThrow('the object changed after it was inspected');
    // Nothing was released, and the swapped object is still waiting to be scanned.
    expect(await storedKeys()).toContain(quarantine);
    expect(await storedKeys()).not.toContain(tenantKey(h.tenant.id, 'docs', id));

    await runScans();
    expect(await rowOf(id)).toMatchObject({ status: 'rejected', rejectionReason: 'infected' });
  });

  it("refuses a link of this organization posted on another organization's host", async () => {
    const bytes = minimalPdf('de otra clinica');

    const { id, posted } = await upload(bytes, `${SLUG}-b`);

    expect(posted.statusCode).toBe(403);
    expect(await storedKeys()).not.toContain(tenantKey(h.tenant.id, 'quarantine', id));
    const confirmed = await h.api.post(`/documents/${id}/uploaded`, h.sessions.professional);
    expect(confirmed.statusCode).toBe(409);
  });

  it('is not served to an organization that does not own it', async () => {
    const { id } = await upload(minimalPdf('privado'));
    await h.api.post(`/documents/${id}/uploaded`, h.sessions.professional);
    await runScans();

    const link = await other.api.post(
      `/documents/${id}/download-link`,
      other.sessions.professional,
    );

    expect(link.statusCode).toBe(404);
  });
});

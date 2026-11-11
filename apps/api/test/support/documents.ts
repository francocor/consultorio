import { randomUUID } from 'node:crypto';

import type {
  CreateUploadsRequest,
  CreateUploadsResponse,
  DocumentDto,
  Role,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import { careAssignment } from '../../src/db/schema/care.js';
import { document } from '../../src/db/schema/documents.js';
import { professional } from '../../src/db/schema/staff.js';
import type { ApplicationOptions } from '../../src/main/application.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant, SYSTEM_USER_ID, type Tx } from '../../src/platform/db/tenant-context.js';
import { uuidv7 } from '../../src/platform/db/uuid.js';

import { buildTestApplication } from './app.js';
import { createRecordingJobClient, type RecordingJobClient } from './jobs.js';
import { createTestPatient } from './patients.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from './session.js';
import { asTenant, createTestTenant, type TestTenant } from './tenants.js';
import { createTestUser } from './users.js';

export interface DocumentsHarness {
  runtime: DbHandle;
  app: FastifyInstance;
  api: ReturnType<typeof clientFor>;
  tenant: TestTenant;
  storage: MemoryObjectStorage;
  jobs: RecordingJobClient;
  /** Signed-in staff. `professional` treats every patient made with `patient()`. */
  sessions: {
    reception: TestSession;
    owner: TestSession;
    admin: TestSession;
    professional: TestSession;
    colleague: TestSession;
  };
  professionalId: string;
  colleagueId: string;
  /** A new patient of the organization, treated by `professional` unless told otherwise. */
  patient(options?: { treatedBy?: 'professional' | 'nobody' }): Promise<string>;
  /** Signs in a new member with these roles. */
  member(roles: Role[]): Promise<TestSession>;
  /** Runs the whole browser side of an upload: request, direct upload to storage, confirmation. */
  upload(
    session: TestSession,
    input: {
      patientId: string;
      category: CreateUploadsRequest['category'];
      name?: string;
      bytes: Buffer;
      contentType?: string;
      replacesDocumentId?: string;
      sha256?: string;
    },
  ): Promise<DocumentDto & { uploadStatus: number }>;
  close(): Promise<void>;
}

let counter = 0;

/**
 * An organization with the staff of every role, an in-memory object storage and a recording job
 * queue: what the document tests need, built once. Tests of the scan add the jobs on top with
 * `withScanning` (support/document-scans.ts).
 */
export async function createDocumentsHarness(
  runtime: DbHandle,
  slug: string,
  overrides: Partial<ApplicationOptions> = {},
): Promise<DocumentsHarness> {
  const tenant = await createTestTenant(runtime, { slug });
  const storage = createMemoryObjectStorage();
  const jobs = createRecordingJobClient();
  const app = buildTestApplication(runtime, { storage, jobs, ...overrides });
  const api = clientFor(app, slug);

  const member = async (roles: Role[]): Promise<TestSession> => {
    const user = await createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
    return signInAs(app, slug, user);
  };

  /** A professional with a profile that passes the gate (active, valid matricula). */
  const professionalMember = async () => {
    counter += 1;
    const user = await createTestUser(runtime, tenant.id, {
      roles: ['professional'],
      password: TEST_PASSWORD,
    });
    const professionalId = uuidv7();
    await asTenant(runtime, tenant.id, (tx) =>
      tx.insert(professional).values({
        id: professionalId,
        tenantId: tenant.id,
        membershipId: user.membershipId,
        matricula: String(70000 + counter),
        matriculaJurisdiction: 'AR-B',
        specialties: ['general'],
      }),
    );
    return { session: await signInAs(app, slug, user), professionalId };
  };

  const reception = await member(['reception']);
  const owner = await member(['owner']);
  const admin = await member(['admin']);
  const treating = await professionalMember();
  const other = await professionalMember();

  const harness: DocumentsHarness = {
    runtime,
    app,
    api,
    tenant,
    storage,
    jobs,
    sessions: {
      reception,
      owner,
      admin,
      professional: treating.session,
      colleague: other.session,
    },
    professionalId: treating.professionalId,
    colleagueId: other.professionalId,
    member,
    async patient(options = {}) {
      const patientId = await createTestPatient(runtime, tenant.id);
      if ((options.treatedBy ?? 'professional') === 'professional') {
        await asTenant(runtime, tenant.id, (tx) =>
          tx.insert(careAssignment).values({
            tenantId: tenant.id,
            patientId,
            professionalId: treating.professionalId,
            assignedBy: randomUUID(),
          }),
        );
      }
      return patientId;
    },
    async upload(session, input) {
      const created = await api.post('/documents/uploads', session, {
        patientId: input.patientId,
        category: input.category,
        ...(input.replacesDocumentId === undefined
          ? {}
          : { replacesDocumentId: input.replacesDocumentId }),
        files: [
          {
            name: input.name ?? 'documento.pdf',
            contentType: input.contentType ?? 'application/pdf',
            size: input.bytes.length,
            ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
          },
        ],
      });
      if (created.statusCode !== 200) {
        throw new Error(`upload request failed with ${String(created.statusCode)}`);
      }
      const first = created.json<CreateUploadsResponse>().uploads[0];
      if (!first) throw new Error('no upload was created');
      const uploadStatus = storage.acceptUpload(
        {
          url: first.upload.url,
          fields: first.upload.fields,
          expiresAt: new Date(first.upload.expiresAt),
        },
        input.bytes,
        input.contentType ?? 'application/pdf',
      );
      const completed = await api.post(`/documents/${first.id}/uploaded`, session);
      if (completed.statusCode !== 200) {
        throw new Error(`upload confirmation failed with ${String(completed.statusCode)}`);
      }
      return { ...completed.json<DocumentDto>(), uploadStatus };
    },
    async close() {
      await app.close();
    },
  };
  await app.ready();
  return harness;
}

/**
 * Runs a callback the way a background job does: as the system user, who sees every document.
 * Tests use it to look at rows that the staff roles are not meant to see.
 */
export function asSystem<T>(
  runtime: DbHandle,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return createWithTenant(runtime.db)({ tenantId, userId: SYSTEM_USER_ID }, fn);
}

/**
 * Releases a document the way the scan does, for tests that need an available document without
 * running the scan: the row becomes available with the given hash.
 */
export async function forceAvailable(
  runtime: DbHandle,
  tenantId: string,
  documentId: string,
  values: { sha256?: string; contentType?: string } = {},
): Promise<void> {
  await createWithTenant(runtime.db)({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [row] = await tx.select().from(document).where(eq(document.id, documentId));
    if (!row) throw new Error('no such document');
    await tx
      .update(document)
      .set({
        status: 'available',
        sha256: values.sha256 ?? randomUUID().replaceAll('-', '').padEnd(64, '0'),
        contentType: values.contentType ?? row.declaredContentType,
        scanResult: 'clean',
        scannedAt: new Date(),
        objectKey: `t/${tenantId}/docs/${documentId}`,
      })
      .where(eq(document.id, documentId));
  });
}

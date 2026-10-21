import { randomBytes } from 'node:crypto';

import type { NoteDto } from '@consultorio/contracts';
import type { LightMyRequestResponse } from 'fastify';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import { createLocalKeyManagement } from '../../src/adapters/local-kek/index.js';
import {
  createMemoryObjectStorage,
  type MemoryObjectStorage,
} from '../../src/adapters/memory-storage/index.js';
import { registerAllExportContributors } from '../../src/main/export-contributors.js';
import {
  CANCELLATION_EXPORT_JOB,
  createCancellationExportJob,
  createExportRegistry,
  enqueuePendingExports,
  type CancellationExportDeps,
  type ExportRegistry,
} from '../../src/modules/tenancy/index.js';
import { createTenantKeys, type TenantKeys } from '../../src/platform/crypto/tenant-keys.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import type { JobDefinition } from '../../src/platform/jobs/define-job.js';

import { createClinicalWorld, type ClinicalWorld, type Professional } from './clinical-world.js';
import { createRecordingJobClient, runPending, type RecordingJobClient } from './jobs.js';
import {
  createOperatorHarness,
  createTestClock,
  operatorSession,
  platformHeaders,
  type OperatorHarness,
  type TestClock,
} from './operator.js';

/** The instant the export job stamps on a package (the zip dates and the file name come from it). */
export const EXPORT_NOW = new Date('2031-05-31T18:00:00.000Z');

export interface RetentionWorld {
  world: ClinicalWorld;
  storage: MemoryObjectStorage;
  jobs: RecordingJobClient;
  email: FakeEmailSender;
  keys: TenantKeys;
  /** The registry the job builds from: every module's contributor, as `main` registers them. */
  exports: ExportRegistry;
  operator: { harness: OperatorHarness; clock: TestClock; cookie: string; id: string };
  /** The export job, built the way the worker builds it unless a test changes a dependency. */
  job(overrides?: Partial<CancellationExportDeps>): JobDefinition;
  /** A professional with a signed entry for a patient; returns the entry. */
  signedEntry(
    by: Professional,
    patientId: string,
    content: Record<string, unknown>,
  ): Promise<NoteDto>;
  /** The operator cancels the organization (the route of task 6.36), with a reason unless told otherwise (`null`: no body at all). */
  cancel(tenantId?: string, body?: unknown): Promise<LightMyRequestResponse>;
  /** What the worker does after a cancellation: looks for the request, queues the job, runs it. */
  buildPackages(overrides?: Partial<CancellationExportDeps>): Promise<void>;
  close(): Promise<void>;
}

/**
 * An organization that can be cancelled and exported, as the retention tests need it: the clinical
 * world (owner, admin, reception, professionals, patients and signed entries) on the real
 * application, with an operator console, an in-memory bucket, a recording job queue and a fake
 * email, plus the export job wired exactly as the worker wires it.
 */
export async function createRetentionWorld(
  runtime: DbHandle,
  slug: string,
  options: { storage?: MemoryObjectStorage } = {},
): Promise<RetentionWorld> {
  const keys = createTenantKeys({
    kms: createLocalKeyManagement(randomBytes(32).toString('base64')),
  });
  const storage = options.storage ?? createMemoryObjectStorage();
  const jobs = createRecordingJobClient();
  const email = createFakeEmailSender();
  const harness = createOperatorHarness();
  const clock = createTestClock();

  const world = await createClinicalWorld(runtime, slug, {
    keys,
    storage,
    jobs,
    email,
    operator: { database: harness.db, secrets: harness.secrets },
    clock: clock.read,
    logLevel: 'error',
  });
  const operatorAccount = await harness.addOperator();
  const cookie = await operatorSession(world.app, operatorAccount, clock);

  const exports = createExportRegistry();
  registerAllExportContributors(exports, { keys });
  const withTenant = createWithTenant(runtime.db);

  const job = (overrides: Partial<CancellationExportDeps> = {}) =>
    createCancellationExportJob({
      exports,
      withTenant,
      storage,
      clock: () => EXPORT_NOW,
      notify: { email, origins: (tenantSlug) => `https://${tenantSlug}.consultorio.test` },
      log: {
        info: () => undefined,
        error: (data, message) => {
          console.error(message, data);
        },
      },
      ...overrides,
    }) as unknown as JobDefinition;

  return {
    world,
    storage,
    jobs,
    email,
    keys,
    exports,
    operator: { harness, clock, cookie, id: operatorAccount.id },
    job,
    async signedEntry(by, patientId, content) {
      const draft = await world.open(by, patientId);
      await world.api.put(`/encounters/${draft.encounterId}/note/draft`, by.session, {
        content,
        baseRevision: 0,
      });
      return (
        await world.api.post(`/notes/${draft.id}/sign`, by.session, { expectedRevision: 1 })
      ).json<NoteDto>();
    },
    cancel(tenantId = world.tenant.id, body: unknown = { reason: 'Fin del contrato acordado' }) {
      return world.app.inject({
        method: 'POST',
        url: `/operator/tenants/${tenantId}/cancel`,
        headers: platformHeaders(cookie),
        remoteAddress: '10.97.0.1',
        ...(body === null ? {} : { payload: body as object }),
      });
    },
    async buildPackages(overrides = {}) {
      // The sweep looks at every organization of the shared database. Another test file may have
      // left one cancelled and not exported, sealed with the keys of its own world: this world
      // builds only the request of its own organization.
      const sweep = createRecordingJobClient();
      await enqueuePendingExports(runtime.db, sweep);
      for (const next of sweep.jobs) {
        if (next.payload.tenantId === world.tenant.id) jobs.jobs.push(next);
      }
      const results = await runPending(runtime.db, jobs, [job(overrides)]);
      for (const { name, result } of results) {
        if (name !== CANCELLATION_EXPORT_JOB || result.status !== 'completed') {
          throw new Error(`the export job did not complete: ${JSON.stringify(result)}`);
        }
      }
    },
    async close() {
      await world.close();
      await harness.close();
    },
  };
}

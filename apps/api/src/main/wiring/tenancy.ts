import { createFakeArchiveStore } from '../../adapters/archive-fake/index.js';
import type { FakeArchiveStore } from '../../adapters/archive-fake/index.js';
import { createLocalArchiveStore } from '../../adapters/archive-local/index.js';
import { createS3ObjectStorage } from '../../adapters/s3/index.js';
import {
  createArchive,
  createArchiveKeyWriter,
  createArchiveVerifyJob,
  createArchiveWriteJob,
  createCancellation,
  createCancellationExportJob,
  createExportRegistry,
  enqueueDueArchives,
  enqueueDueVerifications,
  enqueuePendingExports,
  operatorCancelRoutes,
} from '../../modules/tenancy/index.js';
import { createTenantKeys } from '../../platform/crypto/tenant-keys.js';
import { createWithTenant } from '../../platform/db/tenant-context.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';
import { registerAllExportContributors } from '../export-contributors.js';
import { createKeyManagement } from '../key-management.js';

import { originsFromConfig } from './origins.js';
import type { ModuleWiring } from './types.js';

/**
 * The in-memory archive store that serves the demo organizations. One per configuration, like the
 * other demo fakes. A demo organization is never archived for real: its end is the demo reset.
 */
const demoStores = new WeakMap<Config, FakeArchiveStore>();
export function demoArchiveStoreOf(config: Config): FakeArchiveStore {
  let store = demoStores.get(config);
  if (!store) {
    store = createFakeArchiveStore();
    demoStores.set(config, store);
  }
  return store;
}

/** How often the worker looks for an organization whose export is waiting (seconds, in effect). */
const EXPORT_SWEEP_EVERY_MS = 30_000;
/** How often it looks for an archive that is due to be written or verified. */
const ARCHIVE_SWEEP_EVERY_MS = 300_000;
/** An archive is verified again after this many days. */
const VERIFY_EVERY_DAYS = 7;
/**
 * The archive settings of a configuration. A wiring context built by hand (the wiring tests) may
 * carry no provider settings at all: that is "no archive".
 */
const archiveOf = (config: Config) =>
  (config as { providers?: Config['providers'] }).providers?.archive;
/** Who the archive store is resolved for: the platform, not an organization. */
const PLATFORM = { id: '00000000-0000-0000-0000-000000000000', isDemo: false } as const;

/**
 * Everything the end of an organization registers with the composition root (Track C: the
 * cancellation export and the retention archive, both inside the tenancy module). The track edits
 * this file, `modules/tenancy/{cancellation,archive}/` and nothing shared: it fills the customer slot
 * of the `archiveStore` port (`adapters/archive-local`, marked `fake()`), subscribes to
 * `context.tenantLifecycle.onCancelled` in `create`, adds its jobs (`export.build` for the
 * cancellation export, `archive.write`, `archive.verify`) to the worker, registers the download of
 * the packages as a `FileResource` of the staff door, and mounts its views in the operator console
 * (`operatorRoutes`: the cancellation of task 6.36 and the releases of task 6.41). The job
 * `archive.release` runs only in the `releaser` process role. Its audit actions, queues, the
 * `archive_release` token kind (disabled until task 6.41) and the lifecycle door already exist.
 */
export const tenancyWiring: ModuleWiring = {
  name: 'tenancy',
  // The customer store is the local MinIO bucket with Object Lock when it is configured (marked as
  // a fake: it reaches nothing outside the machine); without it nothing is archived. Demo
  // organizations get the in-memory fake.
  adapters: ({ config }) => {
    const archive = archiveOf(config);
    return {
      archiveStore: {
        real: archive ? fake(createLocalArchiveStore(archive.storage)) : undefined,
        demo: fake(demoArchiveStoreOf(config)),
      },
    };
  },
  // Cancelling queues the export, and the archive jobs follow it.
  needsJobs: true,
  create: (context) => {
    // The export is made of the contributors every module registers: the composition root's registry.
    const exports = createExportRegistry();
    registerAllExportContributors(exports, { keys: context.keys });
    const cancellation = createCancellation({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      exports,
      lifecycle: context.tenantLifecycle,
      jobs: context.jobs,
      fileResources: context.fileResources,
      ...(context.clock ? { clock: context.clock } : {}),
    });
    const archive = createArchive({
      withTenant: context.withTenant,
      adapters: context.adapters,
      email: context.email,
      jobs: context.jobs,
      ...(context.clock ? { clock: context.clock } : {}),
    });
    return {
      routes: (app) => {
        cancellation.routes(app);
        archive.routes(app);
      },
    };
  },
  // The operator cancels an organization: single-tenant deployments and local testing (task 6.36).
  operatorRoutes: (context) =>
    operatorCancelRoutes({
      run: context.run,
      tenantCancelled: context.tenantCancelled,
      clock: context.clock,
    }),
  worker: ({ config, email, clock, adapters }) => {
    // The bucket of the packages is the one of the documents. It is opened when the first job needs it.
    let storage: ObjectStorage | undefined;
    const bucket = () => {
      if (!storage && config.storage) storage = createS3ObjectStorage(config.storage);
      return storage;
    };
    // The contributors of the clinical parts decrypt with the key service, like the API's.
    const exports = createExportRegistry();
    registerAllExportContributors(exports, {
      keys: createTenantKeys({ kms: createKeyManagement(config.kms) }),
    });
    const now = clock ?? (() => new Date());
    const archive = archiveOf(config);
    // The write-once store, resolved for the platform. Absent when the archive is not configured.
    const archiveStore = () => adapters.forTenant(PLATFORM, 'archiveStore');
    return {
      jobs: ({ db, log }) => {
        const found = bucket();
        // Without a bucket there is nowhere to put a package: the job is not registered.
        if (!found) return [];
        const withTenant = createWithTenant(db);
        const archiveJobs = (() => {
          const store = archiveStore();
          if (!archive || !store) return [];
          return [
            createArchiveWriteJob({
              exports,
              withTenant,
              storage: found,
              store,
              keys: createArchiveKeyWriter({
                withTenant,
                releaserPublicKey: archive.releaserPublicKey,
              }),
              clock: now,
              retentionDays: archive.retentionDays,
              afterDays: archive.afterDays,
              log,
            }),
            createArchiveVerifyJob({ withTenant, store, clock: now, log }),
          ];
        })();
        return [
          createCancellationExportJob({
            exports,
            withTenant,
            storage: found,
            clock: now,
            notify: { email, origins: originsFromConfig(config) },
            log,
          }),
          ...archiveJobs,
        ];
      },
      schedules: ({ client, db }) => [
        {
          // The cancelling transaction only writes the request; this is what turns it into a job.
          name: 'cancellation export tick',
          intervalMs: EXPORT_SWEEP_EVERY_MS,
          run: async () => {
            await enqueuePendingExports(db, client);
          },
        },
        ...(archive && archiveStore()
          ? [
              {
                // The archive is written once the window of the export is over, and checked now and then.
                name: 'archive tick',
                intervalMs: ARCHIVE_SWEEP_EVERY_MS,
                run: async () => {
                  await enqueueDueArchives(db, client, { afterDays: archive.afterDays });
                  await enqueueDueVerifications(db, client, { everyDays: VERIFY_EVERY_DAYS });
                },
              },
            ]
          : []),
      ],
    };
  },
};

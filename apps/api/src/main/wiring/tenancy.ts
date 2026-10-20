import { createFakeArchiveStore } from '../../adapters/archive-fake/index.js';
import type { FakeArchiveStore } from '../../adapters/archive-fake/index.js';
import { createS3ObjectStorage } from '../../adapters/s3/index.js';
import {
  createArchive,
  createCancellation,
  createCancellationExportJob,
  createExportRegistry,
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
  // No customer store yet: nothing is archived for customers; demo organizations get the fake.
  adapters: ({ config }) => ({
    archiveStore: { real: undefined, demo: fake(demoArchiveStoreOf(config)) },
  }),
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
  worker: ({ config, email, clock }) => {
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
    return {
      jobs: ({ db, log }) => {
        const found = bucket();
        // Without a bucket there is nowhere to put a package: the job is not registered.
        return found
          ? [
              createCancellationExportJob({
                exports,
                withTenant: createWithTenant(db),
                storage: found,
                clock: clock ?? (() => new Date()),
                notify: { email, origins: originsFromConfig(config) },
                log,
              }),
            ]
          : [];
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
      ],
    };
  },
};

import { createFakeArchiveStore } from '../../adapters/archive-fake/index.js';
import type { FakeArchiveStore } from '../../adapters/archive-fake/index.js';
import {
  createArchive,
  createCancellation,
  createExportRegistry,
} from '../../modules/tenancy/index.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';
import { registerAllExportContributors } from '../export-contributors.js';

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
};

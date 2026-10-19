import { createFakePrescriptionProvider } from '../../adapters/erx-fake/index.js';
import type { FakePrescriptionProvider } from '../../adapters/erx-fake/index.js';
import { createPrescriptions } from '../../modules/prescriptions/index.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';

import type { ModuleWiring } from './types.js';

/**
 * The in-memory fake that serves the demo organizations. One per configuration, so the adapter
 * registry and the provider console, which are both built from the same `config`, hold the same
 * one: the console can put the demo provider in a mode (an outage, a timeout) and the demo
 * prescribes with it. Track A3 uses it from its console entry.
 */
const demoProviders = new WeakMap<Config, FakePrescriptionProvider>();
export function demoPrescriptionProviderOf(config: Config): FakePrescriptionProvider {
  let provider = demoProviders.get(config);
  if (!provider) {
    provider = createFakePrescriptionProvider();
    demoProviders.set(config, provider);
  }
  return provider;
}

/**
 * Everything the prescriptions module registers with the composition root (Track A3). The track
 * edits this file, `modules/prescriptions/` and nothing shared: it fills the customer slot of the
 * `prescriptionProvider` port when its simulator exists (`adapters/erx-local`, marked `fake()`),
 * sets `needsJobs` for `erx.submit`, adds its jobs (`erx.submit`, `erx.reconcile`) to the worker,
 * registers the file resource of a prescription document and the simulator controls of the console.
 */
export const prescriptionsWiring: ModuleWiring = {
  name: 'prescriptions',
  // No customer adapter yet: nothing is issued for customers; demo organizations get the fake.
  adapters: ({ config }) => ({
    prescriptionProvider: { real: undefined, demo: fake(demoPrescriptionProviderOf(config)) },
  }),
  devProviders: ({ config }) => [
    {
      id: 'erx',
      label: 'e-Rx',
      // The simulator adds its mode (ok, down, timeout_after_issue) when it exists.
      status: () =>
        Promise.resolve({ adapter: adapterOfSetting(config.providers.erx), mode: null }),
    },
  ],
  create: (context) =>
    createPrescriptions({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      adapters: context.adapters,
      jobs: context.jobs,
      fileResources: context.fileResources,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
};

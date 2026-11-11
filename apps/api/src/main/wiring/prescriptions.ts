import { randomBytes } from 'node:crypto';

import { createFakePrescriptionProvider } from '../../adapters/erx-fake/index.js';
import type { FakePrescriptionProvider } from '../../adapters/erx-fake/index.js';
import { erxDevRoutes } from '../../adapters/erx-local/dev-routes.js';
import {
  createLocalErxControls,
  createLocalPrescriptionProvider,
  type LocalErxControls,
} from '../../adapters/erx-local/index.js';
import { searchGenericNames } from '../../adapters/erx-local/inn-sample.js';
import {
  ERX_RECONCILE_JOB,
  asWebhookVerifier,
  createErxJobs,
  createPrescriptions,
} from '../../modules/prescriptions/index.js';
import { createTenantKeys } from '../../platform/crypto/tenant-keys.js';
import { createRuntimeDb } from '../../platform/db/pool.js';
import { createWithTenant } from '../../platform/db/tenant-context.js';
import { fanOut } from '../../platform/jobs/worker.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';
import { createKeyManagement } from '../key-management.js';
import { createConfiguredStorage } from '../storage.js';

import type { ModuleWiring } from './types.js';

/**
 * Whether e-prescription runs on the local simulator. A wiring context built by hand (the wiring
 * tests) may carry no provider settings at all: that is "no simulator".
 */
const usesSimulator = (config: Config) =>
  (config as { providers?: Config['providers'] }).providers?.erx === 'local';

/**
 * The secret that signs the simulator's webhook when none is configured. The API process both
 * verifies the webhook and signs the simulated notices, so one secret per process is enough; the
 * worker never verifies anything. It is not a default anyone could know.
 */
const PROCESS_SECRET = randomBytes(24).toString('hex');
const webhookSecretOf = (config: Config) => config.providers.erxWebhookSecret ?? PROCESS_SECRET;

/**
 * The in-memory fake that serves the demo organizations. One per configuration, so the adapter
 * registry and the provider console, which are both built from the same `config`, hold the same
 * one: the console can put the demo provider in a mode (an outage, a timeout) and the demo
 * prescribes with it.
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
 * What the console drives: the local simulator that serves customers (when it runs) and the fake of
 * the demo organizations, always, so a demo can show an outage too. The mode shown is the
 * simulator's; the prescriptions listed are the simulator's (the fake keeps its own in memory).
 */
function composedControls(
  local: LocalErxControls | undefined,
  demo: FakePrescriptionProvider,
): LocalErxControls {
  return {
    mode: () => (local ? local.mode() : Promise.resolve(demo.mode())),
    async setMode(mode) {
      demo.setMode(mode);
      await local?.setMode(mode);
    },
    prescriptions: (limit) => (local ? local.prescriptions(limit) : Promise.resolve([])),
    async advance(externalId, to) {
      const held = demo
        .prescriptions()
        .some(
          (prescription) =>
            prescription.externalId === externalId && prescription.state === 'issued',
        );
      if (held) demo.advance(externalId, to);
      const moved = (await local?.advance(externalId, to)) ?? false;
      return held || moved;
    },
    async reset() {
      demo.reset();
      await local?.reset();
    },
  };
}

/** Who the webhook belongs to: nobody. The resolver only needs to know it is not a demo. */
const PLATFORM = { id: '00000000-0000-0000-0000-000000000000', isDemo: false } as const;

/** How often every organization is asked where its prescriptions stand (every two minutes). */
const RECONCILE_EVERY_MS = 120_000;

/**
 * Everything the prescriptions module registers with the composition root (Track A3). The track
 * edits this file, `modules/prescriptions/` and nothing shared: it fills the customer slot of the
 * `prescriptionProvider` port with its simulator (`adapters/erx-local`, marked `fake()`), sets
 * `needsJobs` for `erx.submit`, adds its jobs (`erx.submit`, `erx.reconcile`) to the worker,
 * registers the file resource of a prescription document and the simulator controls of the console.
 */
export function createPrescriptionsWiring(
  tuning: { providerTimeoutMs?: number; inFlightPinMs?: number } = {},
): ModuleWiring {
  return {
    name: 'prescriptions',
    // Customers get the local simulator while `ERX_PROVIDER=local` (it reaches nothing outside the
    // process, so it is registered as a fake); the adapter of the authorized platform is the deferred
    // slice S5.D, so with `off` nothing is issued for customers. Demo organizations always get the
    // in-memory fake.
    adapters: ({ config, db }) => ({
      prescriptionProvider: {
        real: usesSimulator(config)
          ? fake(createLocalPrescriptionProvider({ db, webhookSecret: webhookSecretOf(config) }))
          : undefined,
        demo: fake(demoPrescriptionProviderOf(config)),
      },
    }),
    devProviders: ({ config }) => {
      const local = usesSimulator(config);
      // The simulator keeps its state in Postgres; the console reads it through a connection of its own.
      const database = local ? createRuntimeDb(config.databaseUrl) : undefined;
      const localControls = database ? createLocalErxControls(database.db) : undefined;
      const controls = composedControls(localControls, demoPrescriptionProviderOf(config));
      return [
        {
          id: 'erx',
          label: 'e-Rx',
          status: async () => ({
            adapter: adapterOfSetting(config.providers.erx),
            // Only the simulator that serves customers is a mode of the provider; the fake of the demo
            // organizations is driven through the routes. The console lists the providers even when
            // the database is not reachable.
            mode: local ? await controls.mode().catch(() => null) : null,
          }),
          ...(database
            ? {
                routes: erxDevRoutes({
                  controls,
                  provider: createLocalPrescriptionProvider({
                    db: database.db,
                    webhookSecret: webhookSecretOf(config),
                  }),
                }),
              }
            : {}),
        },
      ];
    },
    // A prescription is made in a request and submitted by a job queued in the same transaction.
    needsJobs: true,
    create: (context) =>
      createPrescriptions({
        withTenant: context.withTenant,
        auditDeny: context.auditDeny,
        keys: context.keys,
        adapters: context.adapters,
        jobs: context.jobs,
        fileResources: context.fileResources,
        storage: context.storage,
        catalog: { search: searchGenericNames },
        // The signature of a notice is checked by the provider that signs it, whichever organization
        // it is about: the resolver hands it out for any organization that is not a demo.
        webhookVerifier: asWebhookVerifier(
          context.adapters?.forTenant(PLATFORM, 'prescriptionProvider'),
        ),
        ...(context.clock ? { clock: context.clock } : {}),
        providerTimeoutMs: tuning.providerTimeoutMs,
        inFlightPinMs: tuning.inFlightPinMs,
      }),
    worker: ({ config, clock, adapters }) => {
      const now = clock ?? (() => new Date());
      // The bucket of the prescription PDFs is the one of the documents. It is opened when the first job needs it.
      let storage: ObjectStorage | undefined;
      const bucket = () => {
        if (!storage) storage = createConfiguredStorage(config);
        return storage;
      };
      const keys = createTenantKeys({ kms: createKeyManagement(config.kms) });
      return {
        jobs: ({ client, db, log }) =>
          createErxJobs({
            keys,
            adapters,
            clock: now,
            jobs: client,
            // The mark of an attempt is committed on a transaction of its own, before the provider is called.
            withTenant: createWithTenant(db),
            storage: bucket(),
            log,
          }).definitions,
        schedules: ({ client, db }) => [
          {
            // The clock of the retries and of the status: every organization is asked now and then.
            name: `${ERX_RECONCILE_JOB} tick`,
            intervalMs: RECONCILE_EVERY_MS,
            run: async () => {
              await fanOut(db, client, ERX_RECONCILE_JOB, {
                singletonSeconds: RECONCILE_EVERY_MS / 2000,
              });
            },
          },
        ],
      };
    },
  };
}

export const prescriptionsWiring: ModuleWiring = createPrescriptionsWiring();

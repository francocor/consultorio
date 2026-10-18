import { DEFAULT_INVOICING_SETTINGS, InvoicingSettings } from '@consultorio/contracts';

import { createFakeInvoiceIssuer } from '../../adapters/afip-fake/index.js';
import { afipDevRoutes } from '../../adapters/afip-local/dev-routes.js';
import {
  createLocalAfipControls,
  createLocalInvoiceIssuer,
} from '../../adapters/afip-local/index.js';
import {
  CREDENTIAL_WATCH_JOB,
  createCredentialWatchJob,
  createInvoicing,
} from '../../modules/invoicing/index.js';
import { createRuntimeDb } from '../../platform/db/pool.js';
import { fanOut } from '../../platform/jobs/worker.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';

import type { ModuleWiring } from './types.js';

/**
 * Whether invoices run on the local AFIP simulator. A wiring context built by hand (the wiring
 * tests) may carry no provider settings at all: that is "no simulator".
 */
const usesSimulator = (config: Config) =>
  (config as { providers?: Config['providers'] }).providers?.afip === 'local';

/** How often every organization's certificate is looked at (every six hours). */
const WATCH_EVERY_MS = 6 * 3_600_000;

/**
 * Everything the invoicing module registers with the composition root (Track C). The track edits
 * this file, `modules/invoicing/` and nothing shared: it fills the customer slot of the
 * `invoiceIssuer` port when its AFIP simulator exists (`adapters/afip-local`), sets `needsJobs` for
 * `afip.issue`, adds its jobs to the worker and the simulator controls to the provider console.
 */
export const invoicingWiring: ModuleWiring = {
  name: 'invoicing',
  settingsSections: [
    { key: 'invoicing', schema: InvoicingSettings, defaults: DEFAULT_INVOICING_SETTINGS },
  ],
  // Customers get the local AFIP simulator while `AFIP_PROVIDER=local` (it reaches nothing outside
  // the process, so it is registered as a fake); the WSAA/WSFEv1 adapter is the deferred slice
  // S4.D, so with `afip` or `off` nothing is issued for customers. Demo organizations always get
  // the in-memory fake.
  adapters: ({ config, db }) => ({
    invoiceIssuer: {
      real: usesSimulator(config) ? fake(createLocalInvoiceIssuer({ db })) : undefined,
      demo: fake(createFakeInvoiceIssuer()),
    },
  }),
  devProviders: ({ config }) => {
    const local = usesSimulator(config);
    // The simulator keeps its state in Postgres; the console reads it through a connection of its own.
    const database = local ? createRuntimeDb(config.databaseUrl) : undefined;
    const controls = database ? createLocalAfipControls(database.db) : undefined;
    return [
      {
        id: 'afip',
        label: 'AFIP',
        status: async () => ({
          adapter: adapterOfSetting(config.providers.afip),
          // The console lists the providers even when the database is not reachable.
          mode: controls ? await controls.mode().catch(() => null) : null,
        }),
        ...(controls ? { routes: afipDevRoutes({ controls }) } : {}),
      },
    ];
  },
  create: (context) =>
    createInvoicing({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      adapters: context.adapters,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
  worker: ({ email, clock }) => {
    const now = clock ?? (() => new Date());
    return {
      jobs: () => [createCredentialWatchJob({ email, clock: now })],
      schedules: ({ client, db }) => [
        {
          name: `${CREDENTIAL_WATCH_JOB} tick`,
          intervalMs: WATCH_EVERY_MS,
          // One look per organization per half interval at most, even with several workers.
          run: async () => {
            await fanOut(db, client, CREDENTIAL_WATCH_JOB, {
              singletonSeconds: WATCH_EVERY_MS / 2000,
            });
          },
        },
      ],
    };
  },
};

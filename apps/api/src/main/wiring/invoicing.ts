import { DEFAULT_INVOICING_SETTINGS, InvoicingSettings } from '@consultorio/contracts';

import { createFakeInvoiceIssuer, type FakeInvoiceIssuer } from '../../adapters/afip-fake/index.js';
import { afipDevRoutes } from '../../adapters/afip-local/dev-routes.js';
import {
  createLocalAfipControls,
  createLocalInvoiceIssuer,
  type LocalAfipControls,
} from '../../adapters/afip-local/index.js';
import { createS3ObjectStorage } from '../../adapters/s3/index.js';
import {
  CREDENTIAL_WATCH_JOB,
  createAfipIssueJob,
  createCredentialWatchJob,
  createInvoiceDeliverJob,
  createInvoicePdfJob,
  createInvoicing,
  runDueAttempts,
} from '../../modules/invoicing/index.js';
import { createRuntimeDb } from '../../platform/db/pool.js';
import { fanOut } from '../../platform/jobs/worker.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import type { ObjectStorage } from '../../platform/storage/object-storage.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';

import type { ModuleWiring } from './types.js';

/**
 * Whether invoices run on the local AFIP simulator. A wiring context built by hand (the wiring
 * tests) may carry no provider settings at all: that is "no simulator".
 */
const usesSimulator = (config: Config) =>
  (config as { providers?: Config['providers'] }).providers?.afip === 'local';

/**
 * The in-memory fake that serves the demo organizations. One per configuration, so the adapter
 * registry and the provider console, which are both built from the same `config`, hold the same one:
 * the console can put the demo issuer in a mode (an outage, a timeout) and the demo issues with it.
 */
const demoIssuers = new WeakMap<Config, FakeInvoiceIssuer>();
function demoIssuerOf(config: Config): FakeInvoiceIssuer {
  let issuer = demoIssuers.get(config);
  if (!issuer) {
    issuer = createFakeInvoiceIssuer();
    demoIssuers.set(config, issuer);
  }
  return issuer;
}

/**
 * What the console drives: the local simulator that serves customers (when it runs) and the fake of
 * the demo organizations, always, so a demo can show an outage too. The mode shown is the
 * simulator's when there is one; the vouchers listed are the simulator's (the fake keeps its own in
 * memory and numbers them per process).
 */
function composedControls(
  local: LocalAfipControls | undefined,
  demo: FakeInvoiceIssuer,
): LocalAfipControls {
  return {
    mode: () => (local ? local.mode() : Promise.resolve(demo.mode())),
    async setMode(mode) {
      demo.setMode(mode);
      await local?.setMode(mode);
    },
    vouchers: (limit) => (local ? local.vouchers(limit) : Promise.resolve([])),
    async reset() {
      demo.reset();
      await local?.reset();
    },
  };
}

/** How often every organization's certificate is looked at (every six hours). */
const WATCH_EVERY_MS = 6 * 3_600_000;

/** How often the pending invoices that are due are tried again (the shortest wait is a minute). */
const RETRY_EVERY_MS = 30_000;

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
      demo: fake(demoIssuerOf(config)),
    },
  }),
  devProviders: ({ config }) => {
    const local = usesSimulator(config);
    // The simulator keeps its state in Postgres; the console reads it through a connection of its own.
    const database = local ? createRuntimeDb(config.databaseUrl) : undefined;
    const controls = composedControls(
      database ? createLocalAfipControls(database.db) : undefined,
      demoIssuerOf(config),
    );
    return [
      {
        id: 'afip',
        label: 'AFIP',
        status: async () => ({
          adapter: adapterOfSetting(config.providers.afip),
          // The console lists the providers even when the database is not reachable.
          mode: await controls.mode().catch(() => null),
        }),
        routes: afipDevRoutes({ controls }),
      },
    ];
  },
  // An invoice is requested in a request and submitted by a job queued in the same transaction.
  needsJobs: true,
  create: (context) =>
    createInvoicing({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      keys: context.keys,
      adapters: context.adapters,
      jobs: context.jobs,
      fileResources: context.fileResources,
      ...(context.clock ? { clock: context.clock } : {}),
    }),
  worker: ({ config, email, clock, adapters }) => {
    const now = clock ?? (() => new Date());
    // The bucket of the invoice PDFs is the one of the documents. It is opened when the first job needs it.
    let storage: ObjectStorage | undefined;
    const bucket = () => {
      if (!storage && config.storage) storage = createS3ObjectStorage(config.storage);
      return storage;
    };
    return {
      jobs: ({ client }) => {
        const found = bucket();
        return [
          createCredentialWatchJob({ email, clock: now }),
          createAfipIssueJob({ adapters, clock: now, jobs: client }),
          createInvoiceDeliverJob({ email, clock: now }),
          // Without a bucket there is nowhere to put a PDF: the job is not registered, an invoice
          // has no document, and the API answers "not ready" to the link.
          ...(found ? [createInvoicePdfJob({ storage: found, clock: now, jobs: client })] : []),
        ];
      },
      schedules: ({ client, db, log }) => [
        {
          // The clock of the retries: a pending invoice whose next attempt is due is tried again.
          name: 'afip.issue retries',
          intervalMs: RETRY_EVERY_MS,
          run: async () => {
            await runDueAttempts(db, { adapters, clock: now, jobs: client }, log);
          },
        },
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

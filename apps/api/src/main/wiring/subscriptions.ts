import { randomBytes } from 'node:crypto';

import { createFakePaymentsGateway } from '../../adapters/mercadopago-fake/index.js';
import type { FakePaymentsGateway } from '../../adapters/mercadopago-fake/index.js';
import { checkoutRoutes } from '../../adapters/mercadopago-local/checkout-routes.js';
import { paymentsDevRoutes } from '../../adapters/mercadopago-local/dev-routes.js';
import {
  createLocalPaymentsControls,
  createLocalPaymentsGateway,
  type LocalPaymentsGateway,
} from '../../adapters/mercadopago-local/index.js';
import {
  DUNNING_STEP_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  TRIAL_END_JOB,
  createSubscriptionJobs,
  createSubscriptions,
  subscriptionOperatorRoutes,
} from '../../modules/subscriptions/index.js';
import { createTenantLifecycle } from '../../modules/tenancy/index.js';
import { createRuntimeDb, type Db } from '../../platform/db/pool.js';
import { createWithTenant } from '../../platform/db/tenant-context.js';
import { fanOut } from '../../platform/jobs/worker.js';
import { adapterOfSetting } from '../../platform/local-providers/dev-routes.js';
import { fake } from '../adapter-resolver.js';
import type { Config } from '../config.js';

import { originsFromConfig } from './origins.js';
import type { ModuleWiring } from './types.js';

/**
 * The in-memory fake that serves the demo organizations. One per configuration, so the adapter
 * registry and the provider console, which are both built from the same `config`, hold the same
 * one: the console can put the demo gateway in a mode (an outage, a lost answer) and the demo uses
 * it. A demo organization is billing-exempt and never subscribes, so this slot exists for the guard
 * of the adapter resolver ("a demo organization never reaches a real service") and for the demo
 * seed, not for a flow.
 */
const demoGateways = new WeakMap<Config, FakePaymentsGateway>();
export function demoPaymentsGatewayOf(config: Config): FakePaymentsGateway {
  let gateway = demoGateways.get(config);
  if (!gateway) {
    gateway = createFakePaymentsGateway();
    demoGateways.set(config, gateway);
  }
  return gateway;
}

/**
 * Whether the payments run on the local simulator. A wiring context built by hand (the wiring tests)
 * may carry no provider settings at all: that is "no simulator".
 */
const usesSimulator = (config: Config) =>
  (config as { providers?: Config['providers'] }).providers?.payments === 'local';

/**
 * The secret that signs the simulator's webhook when none is configured. The API process both verifies
 * the webhook and signs the simulated notices, so one secret per process is enough; the worker never
 * verifies anything. It is not a default anyone could know.
 */
const PROCESS_SECRET = randomBytes(24).toString('hex');
const webhookSecretOf = (config: Config) => config.providers.mpWebhookSecret ?? PROCESS_SECRET;

/**
 * Where the hosted checkout and the webhook are reached from outside: `MP_PUBLIC_BASE_URL`, else the
 * platform host (the API is served under `/api` by the reverse proxy of the deployment).
 */
export function publicBaseUrlOf(config: Config): string {
  if (config.providers.mpPublicBaseUrl !== undefined) return config.providers.mpPublicBaseUrl;
  const scheme = config.cookieSecure ? 'https' : 'http';
  const port = config.publicPort === undefined ? '' : `:${String(config.publicPort)}`;
  return `${scheme}://${config.platformHost ?? 'localhost'}${port}/api`;
}

const localGatewayOf = (config: Config, db: Db): LocalPaymentsGateway =>
  createLocalPaymentsGateway({
    db,
    webhookSecret: webhookSecretOf(config),
    publicBaseUrl: publicBaseUrlOf(config),
    hostedCheckout: config.providers.localProvidersConsole,
  });

/** Who the gateway belongs to: nobody. The resolver only needs to know it is not a demo. */
const PLATFORM = { id: '00000000-0000-0000-0000-000000000000', isDemo: false } as const;

/** How often every organization is asked where its subscription stands when no notice arrives (5 minutes). */
const RECONCILE_EVERY_MS = 300_000;

/** How often the dates of every subscription are looked at (10 minutes). */
const DATES_EVERY_MS = 600_000;

const isLocalGateway = (gateway: unknown): gateway is LocalPaymentsGateway => {
  const candidate = gateway as Partial<LocalPaymentsGateway> | undefined;
  return candidate?.hostedCheckout === true && candidate.controls !== undefined;
};

/**
 * Everything the subscriptions module registers with the composition root (Track A). The track
 * edits this file, `modules/subscriptions/` and nothing shared: it fills the customer slot of the
 * `paymentsGateway` port with its simulator (`adapters/mercadopago-local`, marked `fake()`), adds the
 * simulator controls to its console entry, adds its jobs to the worker, mounts its routes behind the
 * `subscriptions` feature (`featureRoutes`) and its views in the operator console
 * (`operatorRoutes`). Its permission (`billing.manage`), audit actions, queues and the doors the
 * other modules call (`createQuotaPolicy`, `createSubscriptionPlanImpact`, `createTrialStarter`)
 * already exist.
 */
export const subscriptionsWiring: ModuleWiring = {
  name: 'subscriptions',
  // Customers get the local simulator while `PAYMENTS_PROVIDER=local` (it reaches nothing outside the
  // process, so it is registered as a fake); the real gateway is the deferred slice S6.D, so with
  // `off` nobody can subscribe. Demo organizations always get the in-memory fake.
  adapters: ({ config, db }) => ({
    paymentsGateway: {
      real: usesSimulator(config) ? fake(localGatewayOf(config, db)) : undefined,
      demo: fake(demoPaymentsGatewayOf(config)),
    },
  }),
  devProviders: ({ config }) => {
    const local = usesSimulator(config);
    // The simulator keeps its state in Postgres; the console reads it through a connection of its own.
    const database = local ? createRuntimeDb(config.databaseUrl) : undefined;
    const controls = database ? createLocalPaymentsControls(database.db) : undefined;
    return [
      {
        id: 'payments',
        label: 'Mercado Pago',
        status: async () => ({
          adapter: adapterOfSetting(config.providers.payments),
          // The console lists the providers even when the database is not reachable.
          mode: controls ? await controls.mode().catch(() => null) : null,
        }),
        ...(database && controls
          ? {
              routes: paymentsDevRoutes({
                controls,
                gateway: localGatewayOf(config, database.db),
              }),
            }
          : {}),
      },
    ];
  },
  // A checkout, a plan change and the cancellation are made in a request and followed up by jobs.
  needsJobs: true,
  // The support view of the subscriptions, inside the operator console (behind its session).
  operatorRoutes: (context) => subscriptionOperatorRoutes({ run: context.run }),
  create: (context) => {
    const subscriptions = createSubscriptions({
      withTenant: context.withTenant,
      auditDeny: context.auditDeny,
      email: context.email,
      origins: context.origins,
      rateLimitStore: context.rateLimitStore,
      jobs: context.jobs,
      adapters: context.adapters,
      tenantCancelled: context.tenantLifecycle,
      ...(context.clock ? { clock: context.clock } : {}),
    });
    // The hosted page of the local simulator: only while the provider console is on.
    const gateway = context.adapters?.forTenant(PLATFORM, 'paymentsGateway');
    const hosted = isLocalGateway(gateway)
      ? checkoutRoutes({ controls: gateway.controls, gateway })
      : undefined;
    return {
      featureRoutes: {
        subscriptions: (app) => {
          subscriptions.routes(app);
          hosted?.(app);
        },
      },
    };
  },
  worker: ({ config, adapters, email, clock }) => {
    // Billing exists only where organizations are billed: a single-tenant deployment has no jobs.
    if (config.deploymentMode !== 'multi') return {};
    const now = clock ?? (() => new Date());
    return {
      jobs: ({ client, db, log }) =>
        createSubscriptionJobs({
          // Every step of a reconcile runs in short transactions of its own, with the mark of a write
          // committed before its call; the transaction the framework opens stays idle meanwhile.
          withTenant: createWithTenant(db),
          adapters,
          jobs: client,
          email,
          origins: originsFromConfig(config),
          clock: now,
          // The end of a subscription is announced to retention through this bus.
          tenantCancelled: createTenantLifecycle(),
          log,
        }).definitions,
      schedules: ({ client, db }) => [
        {
          // The clock that heals an outage: every organization is asked where its subscription stands.
          name: `${SUBSCRIPTION_RECONCILE_JOB} tick`,
          intervalMs: RECONCILE_EVERY_MS,
          run: async () => {
            await fanOut(db, client, SUBSCRIPTION_RECONCILE_JOB, {
              singletonSeconds: RECONCILE_EVERY_MS / 2000,
            });
          },
        },
        {
          // The clock of the dates: the end of a trial, the reminders and the end of a grace.
          name: `${TRIAL_END_JOB} tick`,
          intervalMs: DATES_EVERY_MS,
          run: async () => {
            await fanOut(db, client, TRIAL_END_JOB, { singletonSeconds: DATES_EVERY_MS / 2000 });
            await fanOut(db, client, DUNNING_STEP_JOB, { singletonSeconds: DATES_EVERY_MS / 2000 });
          },
        },
      ],
    };
  },
};

import { sql } from 'drizzle-orm';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import {
  createFakeEmailSender,
  type FakeEmailSender,
} from '../../src/adapters/fake-email/index.js';
import type { PaymentsGatewayHarness } from '../../src/adapters/payments-gateway.contract.js';
import type { AdapterResolver } from '../../src/main/adapter-resolver.js';
import type { ApplicationOptions } from '../../src/main/application.js';
import {
  createTrialStarter,
  type SubscriptionDeps,
} from '../../src/modules/subscriptions/index.js';
import {
  createTenantLifecycle,
  type TenantCancelledEvent,
} from '../../src/modules/tenancy/index.js';
import type { DbHandle } from '../../src/platform/db/pool.js';
import { createWithTenant } from '../../src/platform/db/tenant-context.js';
import { createPublicOrigins } from '../../src/platform/http/public-origin.js';

import { BASE_DOMAIN, buildTestApplication } from './app.js';
import { createRecordingJobClient, type RecordingJobClient } from './jobs.js';
import { clientFor, signInAs, TEST_PASSWORD, type TestSession } from './session.js';
import { asTenant, createTestTenant, type TestTenant } from './tenants.js';
import { createTestUser } from './users.js';

/**
 * A world for the subscriptions: the real application, a payments gateway of the test (the in-memory
 * fake, or the local Mercado Pago on Postgres, through the same harness the contract suite uses), a
 * queue that records what was enqueued, a clock the test moves, the email that was sent and the
 * organizations that were cancelled. One world per test file; each test makes the organization it
 * needs (`organization()`), because a subscription is one per organization.
 */
export interface SubscriptionOrganization {
  tenant: TestTenant;
  owner: TestSession;
  /** A member of the organization with another role, signed in. */
  member(role: 'professional' | 'reception' | 'admin'): Promise<TestSession>;
  api: ReturnType<typeof clientFor>;
  /** `GET /subscription` as the owner. */
  view(): Promise<LightMyRequestResponse>;
  /** `POST /subscription/checkout` as the owner. */
  checkout(): Promise<LightMyRequestResponse>;
  /** The subscription row as the database holds it, read as the system. */
  subscription(): Promise<Record<string, unknown>>;
  /** What the organization's rows of a table hold, read as the system. */
  rows(table: string): Promise<Record<string, unknown>[]>;
  /** Runs a statement in the transaction of the organization, as the system (the test arranges a state). */
  run(statement: ReturnType<typeof sql>): Promise<Record<string, unknown>[]>;
}

export interface SubscriptionWorld {
  app: FastifyInstance;
  runtime: DbHandle;
  harness: PaymentsGatewayHarness;
  recorded: RecordingJobClient;
  email: FakeEmailSender;
  /** The clock of the application and of the services: the test moves it. */
  clock: { now: Date };
  /** What the subscription announced to retention. */
  cancelled: TenantCancelledEvent[];
  /** What the services of the module are built with (the same clock, queue, email and gateway). */
  deps: SubscriptionDeps;
  adapters: AdapterResolver;
  organization(options?: {
    trial?: boolean;
    billingExempt?: boolean;
    isDemo?: boolean;
  }): Promise<SubscriptionOrganization>;
  /** Moves the clock forward. */
  advance(ms: number): void;
  /** Signs a notice of the provider with the clock of the world. */
  notice(body: string, at?: number): Promise<{ rawBody: string; headers: Record<string, string> }>;
  /** Posts a notice to the webhook of the application (`POST /webhooks/mercadopago`). */
  post(request: {
    rawBody: string;
    headers: Record<string, string>;
  }): Promise<LightMyRequestResponse>;
  stop(): Promise<void>;
}

let organizations = 0;

export async function createSubscriptionWorld(
  runtime: DbHandle,
  options: {
    harness: PaymentsGatewayHarness;
    /** The clock of the world, shared with the gateway of the harness when the test made both. */
    clock?: { now: Date };
    app?: Partial<ApplicationOptions>;
    providerTimeoutMs?: number;
  },
): Promise<SubscriptionWorld> {
  const { harness } = options;
  const clock = options.clock ?? { now: new Date('2026-10-20T15:00:00.000Z') };
  const recorded = createRecordingJobClient();
  const email = createFakeEmailSender();
  const adapters: AdapterResolver = {
    forTenant: (_tenant, port) =>
      (port === 'paymentsGateway' ? harness.gateway : undefined) as never,
  };
  const lifecycle = createTenantLifecycle();
  const cancelled: TenantCancelledEvent[] = [];
  lifecycle.onCancelled((_tx, event) => {
    cancelled.push(event);
    return Promise.resolve();
  });

  const app = buildTestApplication(runtime, {
    adapters,
    jobs: recorded,
    email,
    clock: () => clock.now,
    ...options.app,
  });
  await app.ready();

  const deps: SubscriptionDeps = {
    withTenant: createWithTenant(runtime.db),
    adapters,
    jobs: recorded,
    email,
    origins: createPublicOrigins({ mode: 'multi', baseDomain: BASE_DOMAIN }, { secure: true }),
    tenantCancelled: lifecycle,
    clock: () => clock.now,
    providerTimeoutMs: options.providerTimeoutMs ?? 2_000,
  };
  const starter = createTrialStarter({ clock: () => clock.now });

  return {
    app,
    runtime,
    harness,
    recorded,
    email,
    clock,
    cancelled,
    deps,
    adapters,
    async organization(orgOptions = {}) {
      organizations += 1;
      const slug = `sub-org-${String(organizations)}-${String(Date.now() % 100_000)}`;
      const tenant = await createTestTenant(runtime, {
        slug,
        ...(orgOptions.billingExempt ? { billingExempt: true } : {}),
        ...(orgOptions.isDemo ? { isDemo: true } : {}),
      });
      const api = clientFor(app, slug);
      const signedIn = async (roles: ('owner' | 'professional' | 'reception' | 'admin')[]) => {
        const user = await createTestUser(runtime, tenant.id, { roles, password: TEST_PASSWORD });
        return signInAs(app, slug, user);
      };
      const owner = await signedIn(['owner']);
      if (orgOptions.trial !== false) {
        await asTenant(runtime, tenant.id, (tx) => starter.startTrial(tx, { tenantId: tenant.id }));
      }
      const run = async (statement: ReturnType<typeof sql>) =>
        (await asTenant(runtime, tenant.id, (tx) => tx.execute(statement))).rows;
      const read = (table: string) => run(sql`SELECT * FROM ${sql.identifier(table)}`);
      return {
        tenant,
        owner,
        member: (role) => signedIn([role]),
        api,
        view: () => api.get('/subscription', owner),
        checkout: () => api.post('/subscription/checkout', owner),
        async subscription() {
          const [row] = await read('subscription');
          if (!row) throw new Error('the organization has no subscription');
          return row;
        },
        rows: read,
        run,
      };
    },
    advance(ms) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
    notice(body, at) {
      return harness.sign(body, at ?? clock.now.getTime());
    },
    post(request) {
      return app.inject({
        method: 'POST',
        url: '/webhooks/mercadopago',
        headers: {
          'content-type': 'application/json',
          host: `platform.${BASE_DOMAIN}`,
          ...request.headers,
        },
        payload: request.rawBody,
        remoteAddress: '10.99.0.2',
      });
    },
    async stop() {
      await app.close();
    },
  };
}

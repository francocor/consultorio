import type { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';

import type { LockoutPolicy } from '../modules/identity/application/lockout.js';
import { createIdentity, type PasswordHasher } from '../modules/identity/index.js';
import { createTenantLookup, type DeploymentSettings } from '../modules/tenancy/index.js';
import type { TenantKeys } from '../platform/crypto/tenant-keys.js';
import type { Db, DbHandle } from '../platform/db/pool.js';
import { createWithTenant } from '../platform/db/tenant-context.js';
import type { HealthDeps } from '../platform/http/health.js';
import { createMemoryRateLimitStore, type RateLimit } from '../platform/http/rate-limit.js';

import { buildServer } from './server.js';

export interface ApplicationOptions {
  /** The runtime database (connects as `app_rw`). */
  database: Pick<DbHandle, 'db'>;
  health: HealthDeps;
  deployment: DeploymentSettings;
  logLevel?: string;
  logStream?: Writable;
  trustProxy: boolean;
  cookieSecure: boolean;
  /** Per-tenant data keys: second-factor secrets are stored encrypted with them. */
  keys: TenantKeys;
  /** Replaceable in tests; production uses the system clock. */
  clock?: () => Date;
  hasher?: PasswordHasher;
  lockout?: LockoutPolicy;
  /** Request limits; defaults protect a single instance. Tests raise them. */
  limits?: Partial<RequestLimits>;
}

export interface RequestLimits {
  perClient: RateLimit;
  perTenant: RateLimit;
  /** Sign-in attempts per client address and tenant. */
  login: { max: number; timeWindow: number };
}

const DEFAULT_LIMITS: RequestLimits = {
  perClient: { max: 300, windowMs: 60_000 },
  perTenant: { max: 6000, windowMs: 60_000 },
  login: { max: 20, timeWindow: 60_000 },
};

/**
 * Wires the application: the tenant host guard, authentication and the routes of every
 * capability that exists in all deployments. `main` and the integration tests both build the
 * server here, so a test exercises exactly the composition that production runs, and
 * authentication cannot be left out of it.
 */
export function createApplication(options: ApplicationOptions): FastifyInstance {
  const db: Db = options.database.db;
  const limits: RequestLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const withTenant = createWithTenant(db);

  const identity = createIdentity({
    withTenant,
    keys: options.keys,
    cookieSecure: options.cookieSecure,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.hasher ? { hasher: options.hasher } : {}),
    ...(options.lockout ? { lockout: options.lockout } : {}),
    loginRateLimit: limits.login,
  });

  return buildServer({
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
    ...(options.logStream ? { logStream: options.logStream } : {}),
    health: options.health,
    deployment: options.deployment,
    trustProxy: options.trustProxy,
    rateLimit: {
      store: createMemoryRateLimitStore(),
      perClient: limits.perClient,
      perTenant: limits.perTenant,
    },
    lookupTenant: createTenantLookup(db),
    auth: { authenticate: identity.authenticate, cookieSecure: options.cookieSecure },
    routes: [identity.routes],
  });
}

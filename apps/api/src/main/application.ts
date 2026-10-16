import type { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';

import { createIdentity, type PasswordHasher } from '../modules/identity/index.js';
import { createTenantLookup, type DeploymentSettings } from '../modules/tenancy/index.js';
import type { Db, DbHandle } from '../platform/db/pool.js';
import { createWithTenant } from '../platform/db/tenant-context.js';
import type { HealthDeps } from '../platform/http/health.js';

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
  /** Replaceable in tests; production uses the system clock. */
  clock?: () => Date;
  hasher?: PasswordHasher;
}

/**
 * Wires the application: the tenant host guard, authentication and the routes of every
 * capability that exists in all deployments. `main` and the integration tests both build the
 * server here, so a test exercises exactly the composition that production runs, and
 * authentication cannot be left out of it.
 */
export function createApplication(options: ApplicationOptions): FastifyInstance {
  const db: Db = options.database.db;
  const withTenant = createWithTenant(db);

  const identity = createIdentity({
    withTenant,
    cookieSecure: options.cookieSecure,
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.hasher ? { hasher: options.hasher } : {}),
  });

  return buildServer({
    ...(options.logLevel === undefined ? {} : { logLevel: options.logLevel }),
    ...(options.logStream ? { logStream: options.logStream } : {}),
    health: options.health,
    deployment: options.deployment,
    trustProxy: options.trustProxy,
    lookupTenant: createTenantLookup(db),
    auth: { authenticate: identity.authenticate, cookieSecure: options.cookieSecure },
    routes: [identity.routes],
  });
}

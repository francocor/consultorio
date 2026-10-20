import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from '../../db/schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

/**
 * How long a request for a connection waits when every connection of the pool is busy. Without a
 * limit a pool that runs dry makes the callers wait for ever; with it they fail and the work is retried
 * (an attempt to issue an invoice holds one connection and asks for a second one for its mark, so a
 * pool full of attempts would otherwise wait on itself: JD-S4 R2-3).
 */
export const CONNECTION_TIMEOUT_MS = 10_000;

/**
 * The most connections the runtime pool opens unless the configuration says otherwise
 * (`DB_POOL_MAX`). Above the floor of the configuration (`MIN_DB_POOL_MAX`, which grows by four with
 * every family of jobs that holds a transaction idle: 14 for the three of Stages 4 and 5 (JD-S5 R4-2),
 * 18 with the reconcile of the payments, 22 with the dunning of Stage 6). 24 leaves two for the rest.
 * `.env.example` still pins 16, the maintainer's line to change (see `docs/runbooks/deploy.md`).
 */
export const DEFAULT_RUNTIME_POOL_MAX = 24;

function open(connectionString: string, max: number): DbHandle {
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  // An idle client error must not crash the process; the next query reports the failure.
  pool.on('error', () => undefined);
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/**
 * Runtime pool: connects as `app_rw`, which owns no table and cannot bypass row level security.
 * Every query must go through `withTenant`.
 */
export function createRuntimeDb(databaseUrl: string, options: { max?: number } = {}): DbHandle {
  return open(databaseUrl, options.max ?? DEFAULT_RUNTIME_POOL_MAX);
}

/**
 * Operator pool: connects as `app_operator`, the role of the platform operator console. It is a
 * different login from the runtime one, with an allowlist of privileges, so a flaw in the tenant
 * API never carries the operator's reach. Small on purpose: there are few operators.
 */
export function createOperatorDb(operatorDatabaseUrl: string): DbHandle {
  return open(operatorDatabaseUrl, 3);
}

/**
 * Sealer pool: connects as `audit_sealer`, a login of its own that only the worker holds. It can
 * fill the seal columns of audit events and read the trails it seals, and nothing else: the API
 * process never has this login, so a flaw in the tenant API cannot rewrite or read the trails.
 */
export function createSealerDb(sealerDatabaseUrl: string): DbHandle {
  return open(sealerDatabaseUrl, 2);
}

/**
 * Owner pool: connects as `app_owner`. Used only to run migrations and by test setup, never by
 * request handling, because the owner is the one role that could be exempted from policies.
 */
export function createOwnerDb(migrationDatabaseUrl: string): DbHandle {
  return open(migrationDatabaseUrl, 2);
}

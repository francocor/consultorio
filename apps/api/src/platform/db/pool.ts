import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from '../../db/schema/index.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

function open(connectionString: string, max: number): DbHandle {
  const pool = new Pool({ connectionString, max });
  // An idle client error must not crash the process; the next query reports the failure.
  pool.on('error', () => undefined);
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/**
 * Runtime pool: connects as `app_rw`, which owns no table and cannot bypass row level security.
 * Every query must go through `withTenant`.
 */
export function createRuntimeDb(databaseUrl: string): DbHandle {
  return open(databaseUrl, 10);
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

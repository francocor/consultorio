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
 * Owner pool: connects as `app_owner`. Used only to run migrations and by test setup, never by
 * request handling, because the owner is the one role that could be exempted from policies.
 */
export function createOwnerDb(migrationDatabaseUrl: string): DbHandle {
  return open(migrationDatabaseUrl, 2);
}

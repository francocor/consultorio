import { Pool } from 'pg';

/** Minimal readiness probe for the database. The full pool and tenant context arrive in Stage 0 (S0.07). */
export interface DbProbe {
  /** Resolves true when the database answers a trivial query, false otherwise. Never throws. */
  check(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDbProbe(databaseUrl: string): DbProbe {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
  });
  // An idle client error must not crash the process; the next check reports the failure.
  pool.on('error', () => undefined);

  return {
    async check() {
      try {
        await pool.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}

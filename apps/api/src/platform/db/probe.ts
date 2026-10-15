import { Pool } from 'pg';

/** Outcome of a readiness check. A failure carries only an error code, never a message. */
export type DbCheckResult = { ok: true } | { ok: false; code: string };

/** Minimal readiness probe for the database. The full pool and tenant context arrive in Stage 0 (S0.07). */
export interface DbProbe {
  /** Resolves with the outcome of a trivial query. Never throws. */
  check(): Promise<DbCheckResult>;
  close(): Promise<void>;
}

/**
 * Extracts a short error code (for example `ECONNREFUSED` or a Postgres SQLSTATE).
 * Messages are ignored on purpose: driver messages can echo connection strings or data.
 */
export function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && code !== '') {
      return code;
    }
  }
  return 'unknown';
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
        return { ok: true };
      } catch (error) {
        return { ok: false, code: errorCode(error) };
      }
    },
    async close() {
      await pool.end();
    },
  };
}

import { sql } from 'drizzle-orm';

import type { Tx } from '../db/tenant-context.js';
import type { Metrics } from '../metrics.js';

import { GENESIS_HASH, hashEvent } from './canonicalize.js';
import { CANONICAL_COLUMNS, toCanonical, type RawChainRow } from './chain.js';

export interface SealOptions {
  /**
   * Only events older than this are sealed. A row is stamped when it is inserted but becomes
   * visible when its transaction commits, so a short wait keeps events that commit slightly late
   * from being sealed after newer ones. Defaults to 2 seconds.
   */
  graceMs?: number;
  /** Most events sealed in one run. Defaults to 500. */
  batchSize?: number;
  metrics?: Metrics;
}

export interface SealResult {
  sealed: number;
  /** Sequence number of the last sealed event after this run (0 when the chain is empty). */
  lastSeq: number;
}

export const DEFAULT_SEAL_GRACE_MS = 2000;
const DEFAULT_BATCH = 500;

/**
 * Seals a tenant's pending audit events into its hash chain.
 *
 * It runs inside a `withTenant` transaction opened on the SEALER's own connection (`createSealerDb`,
 * the `audit_sealer` login only the worker holds): that role is the only one the append-only
 * triggers let fill `seq`, `prev_hash` and `hash`. Events are taken in
 * `(occurred_at, id)` order, numbered after the last sealed one, and each gets
 * `hash = SHA-256(prev_hash || canonical row)`. The run is safe to repeat (it only touches
 * unsealed rows) and safe to run concurrently (a transaction-level advisory lock serializes
 * sealers of the same tenant).
 */
export async function sealTenant(tx: Tx, options: SealOptions = {}): Promise<SealResult> {
  const graceMs = options.graceMs ?? DEFAULT_SEAL_GRACE_MS;
  const batch = options.batchSize ?? DEFAULT_BATCH;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('audit.seal:' || current_setting('app.tenant_id'), 0))`,
  );

  const last = await tx.execute<{ lastSeq: string; hash: string }>(
    sql`SELECT seq::text AS "lastSeq", hash
          FROM audit_event
         WHERE tenant_id = current_setting('app.tenant_id')::uuid AND seq IS NOT NULL
         ORDER BY audit_event.seq DESC
         LIMIT 1`,
  );
  let seq = Number(last.rows[0]?.lastSeq ?? 0);
  let previous = last.rows[0]?.hash ?? GENESIS_HASH;

  const pending = await tx.execute<RawChainRow>(
    sql`SELECT ${CANONICAL_COLUMNS}
          FROM audit_event
         WHERE tenant_id = current_setting('app.tenant_id')::uuid
           AND seq IS NULL
           AND occurred_at <= clock_timestamp() - make_interval(secs => ${graceMs / 1000})
         ORDER BY audit_event.occurred_at, audit_event.id
         LIMIT ${batch}`,
  );

  for (const row of pending.rows) {
    seq += 1;
    const hash = hashEvent(previous, toCanonical(row, seq));
    await tx.execute(
      sql`UPDATE audit_event
             SET seq = ${seq}, prev_hash = ${previous}, hash = ${hash}
           WHERE tenant_id = current_setting('app.tenant_id')::uuid
             AND occurred_at = ${row.occurredAtRaw}::timestamptz
             AND id = ${row.id}::uuid
             AND seq IS NULL`,
    );
    previous = hash;
  }

  if (options.metrics) {
    const lag = await tx.execute<{ lag: number | null }>(
      sql`SELECT extract(epoch FROM clock_timestamp() - min(occurred_at))::float AS lag
            FROM audit_event
           WHERE tenant_id = current_setting('app.tenant_id')::uuid AND seq IS NULL`,
    );
    const tenant = await tx.execute<{ tenant: string }>(
      sql`SELECT current_setting('app.tenant_id') AS tenant`,
    );
    options.metrics.gauge('audit_seal_lag_seconds', lag.rows[0]?.lag ?? 0, {
      tenant: tenant.rows[0]?.tenant ?? 'unknown',
    });
  }

  return { sealed: pending.rows.length, lastSeq: seq };
}

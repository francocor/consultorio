import { sql } from 'drizzle-orm';

import type { Db } from '../db/pool.js';
import type { Metrics } from '../metrics.js';

/** Name of the scheduled task, as it appears in logs and metrics next to `audit.seal` and `audit.verify`. */
export const AUDIT_PARTITIONS_JOB = 'audit.partitions';

/** How many months beyond the current one always exist. */
export const PARTITIONS_AHEAD_MONTHS = 3;

export interface PartitionStatus {
  /** Partitions this run created. */
  created: number;
  /** Months beyond the current one that now have a partition. */
  ahead: number;
}

interface CountRow extends Record<string, unknown> {
  created: number;
  ahead: number;
}

/**
 * Keeps the monthly audit partitions ahead of the calendar (audit-log, ADR-005). An event whose
 * month has no partition cannot be written, and the write is fail-closed, so a missing partition
 * would stop every audited action: it is a platform task, run when the worker starts and every
 * night. It is idempotent, and it never removes anything: old partitions stay (see the runbook
 * `docs/runbooks/audit-retention.md`).
 *
 * This is not a pg-boss queue because a queue job belongs to one tenant, and the partitions are
 * shared by all of them.
 */
export async function ensureAuditPartitions(
  db: Db,
  options: { from?: Date; metrics?: Metrics } = {},
): Promise<PartitionStatus> {
  const from = (options.from ?? new Date()).toISOString().slice(0, 10);
  const result = await db.execute<CountRow>(sql`
    select app.ensure_audit_partitions(${PARTITIONS_AHEAD_MONTHS}, ${from}::date) as created,
           (select count(*)::int
              from pg_inherits i
              join pg_class c on c.oid = i.inhrelid
             where i.inhparent = 'public.audit_event'::regclass
               and c.relname > 'audit_event_' || to_char(date_trunc('month', ${from}::date), 'YYYY_MM')
           ) as ahead`);
  const row = result.rows[0];
  const status = { created: row?.created ?? 0, ahead: row?.ahead ?? 0 };
  options.metrics?.gauge('audit_partitions_ahead', status.ahead);
  if (status.created > 0)
    options.metrics?.increment('audit_partitions_created_total', {}, status.created);
  return status;
}

import { MESSAGE_STATUSES } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import type { Db } from '../platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../platform/db/tenant-context.js';
import { listTenantIds, tenantStatusCounts } from '../platform/jobs/tenant-scan.js';
import type { Metrics } from '../platform/metrics.js';

/**
 * What the worker measures about the platform every minute and exposes to the alert rules (task 6.45,
 * `platform/metrics-catalog.ts` says what each series means): the depth and age of the queues, the
 * failure rate of the messages, the invoices that stayed pending past the outage threshold, the
 * documents waiting for the malware scan, the audit events not sealed yet, the subscriptions by state
 * and reminder of the dunning, and the organizations by status.
 *
 * The queues belong to nobody and are read as they are. Everything else is read organization by
 * organization, each in its own transaction as the system, so row level security holds and nothing
 * here can read across an organization; the answers are summed. Only counts and ages leave: the
 * labels are queue names, statuses and steps. The composition root owns this file because it reads
 * the tables of several modules, which no module may do.
 */

export interface PlatformMetricsDeps {
  db: Db;
  metrics: Metrics;
}

const SUBSCRIPTION_STATUSES = [
  'trial',
  'active',
  'past_due',
  'read_only',
  'cancelling',
  'cancelled',
] as const;
const TENANT_STATUSES = ['active', 'read_only', 'cancelled', 'unverified'] as const;
const DUNNING_STEPS = ['0', '1', '2', '3'] as const;
const JOB_STATES = ['created', 'retry', 'active'] as const;

/** One figure of one organization: a metric, a label value (or none) and the amount. */
interface Reading {
  metric: string;
  label: string;
  value: number;
}

/** Every count of one organization, in one statement (one round trip per organization). */
const READINGS = sql`
  SELECT 'messages_last_day' AS metric, status AS label, count(*)::float AS value
    FROM message WHERE created_at > now() - interval '24 hours' GROUP BY status
  UNION ALL
  SELECT 'invoices_pending_past_threshold', '', count(*)::float
    FROM invoice i
   WHERE i.status = 'pending'
     AND i.created_at < now() - make_interval(hours => coalesce(
           (SELECT (t.settings -> 'invoicing' ->> 'outageThresholdHours')::int FROM tenant t
             WHERE t.id = i.tenant_id), 24))
  UNION ALL
  SELECT 'documents_scan_backlog', '', count(*)::float
    FROM document
   WHERE status = 'quarantined' AND upload_completed_at IS NOT NULL AND abandoned_at IS NULL
  UNION ALL
  SELECT 'documents_scan_oldest_waiting_seconds', '',
         coalesce(extract(epoch FROM now() - min(upload_completed_at)), 0)::float
    FROM document
   WHERE status = 'quarantined' AND upload_completed_at IS NOT NULL AND abandoned_at IS NULL
  UNION ALL
  SELECT 'audit_unsealed_events', '', count(*)::float FROM audit_event WHERE seq IS NULL
  UNION ALL
  SELECT 'audit_oldest_unsealed_seconds', '',
         coalesce(extract(epoch FROM clock_timestamp() - min(occurred_at)), 0)::float
    FROM audit_event WHERE seq IS NULL
  UNION ALL
  SELECT 'subscriptions', status, count(*)::float FROM subscription GROUP BY status
  UNION ALL
  SELECT 'subscription_dunning_step', dunning_step::text, count(*)::float
    FROM subscription WHERE status = 'past_due' GROUP BY dunning_step
`;

/** Sums the readings of every organization; the oldest-wait figures take the maximum instead. */
function combine(readings: readonly Reading[]): Map<string, Map<string, number>> {
  const byMetric = new Map<string, Map<string, number>>();
  const maxima = new Set([
    'documents_scan_oldest_waiting_seconds',
    'audit_oldest_unsealed_seconds',
  ]);
  for (const reading of readings) {
    const labels = byMetric.get(reading.metric) ?? new Map<string, number>();
    const current = labels.get(reading.label) ?? 0;
    labels.set(
      reading.label,
      maxima.has(reading.metric) ? Math.max(current, reading.value) : current + reading.value,
    );
    byMetric.set(reading.metric, labels);
  }
  return byMetric;
}

/** A metric with one series per label value, each of the known ones present even when it is zero. */
function setLabelled(
  metrics: Metrics,
  name: string,
  label: string,
  known: readonly string[],
  values: ReadonlyMap<string, number> | undefined,
): void {
  const labels = [...new Set([...known, ...(values?.keys() ?? [])])];
  metrics.replace(
    name,
    labels.map((value) => ({ labels: { [label]: value }, value: values?.get(value) ?? 0 })),
  );
}

async function measureQueues(db: Db, metrics: Metrics): Promise<void> {
  const result = await db.execute<{
    name: string;
    state: string;
    jobs: number;
    waiting: number | null;
  }>(
    sql`SELECT name, state::text AS state, count(*)::int AS jobs,
               max(CASE WHEN state IN ('created', 'retry') AND start_after <= now()
                        THEN extract(epoch FROM now() - start_after) END)::float AS waiting
          FROM pgboss.job
         WHERE state IN ('created', 'retry', 'active')
         GROUP BY name, state`,
  );
  metrics.replace(
    'queue_jobs',
    result.rows
      .filter((row) => (JOB_STATES as readonly string[]).includes(row.state))
      .map((row) => ({ labels: { queue: row.name, state: row.state }, value: row.jobs })),
  );
  const oldest = new Map<string, number>();
  for (const row of result.rows) {
    if (row.waiting === null) continue;
    oldest.set(row.name, Math.max(oldest.get(row.name) ?? 0, row.waiting));
  }
  metrics.replace(
    'queue_oldest_waiting_seconds',
    [...oldest].map(([queue, seconds]) => ({ labels: { queue }, value: seconds })),
  );
}

/**
 * Measures the platform and sets the series. A failure is counted and rethrown (the worker logs it):
 * the series keep their last values, and `platform_metrics_collected_at_seconds` stops moving, which
 * is what the alert on a silent collector reads.
 */
export async function collectPlatformMetrics(deps: PlatformMetricsDeps): Promise<void> {
  const { db, metrics } = deps;
  try {
    await measureQueues(db, metrics);

    const withTenant = createWithTenant(db);
    const readings: Reading[] = [];
    for (const tenantId of await listTenantIds(db)) {
      const rows = await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
        tx.execute<{ metric: string; label: string; value: number }>(READINGS),
      );
      readings.push(...rows.rows);
    }
    const total = combine(readings);
    const single = (name: string) => total.get(name)?.get('') ?? 0;

    setLabelled(
      metrics,
      'messages_last_day',
      'status',
      MESSAGE_STATUSES,
      total.get('messages_last_day'),
    );
    for (const name of [
      'invoices_pending_past_threshold',
      'documents_scan_backlog',
      'documents_scan_oldest_waiting_seconds',
      'audit_unsealed_events',
      'audit_oldest_unsealed_seconds',
    ]) {
      metrics.gauge(name, single(name));
    }
    setLabelled(
      metrics,
      'subscriptions',
      'status',
      SUBSCRIPTION_STATUSES,
      total.get('subscriptions'),
    );
    setLabelled(
      metrics,
      'subscription_dunning_step',
      'step',
      DUNNING_STEPS,
      total.get('subscription_dunning_step'),
    );
    setLabelled(metrics, 'tenants', 'status', TENANT_STATUSES, await tenantStatusCounts(db));

    metrics.gauge('platform_metrics_collected_at_seconds', Math.floor(Date.now() / 1000));
  } catch (error) {
    metrics.increment('platform_metrics_collection_errors_total');
    throw error;
  }
}

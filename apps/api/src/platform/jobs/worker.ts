import { SEAL_JOB, VERIFY_JOB, createAuditJobs } from '../audit/jobs.js';
import { ensureAuditPartitions } from '../audit/partitions.js';
import { sealPlatformAudit, verifyPlatformChain } from '../audit/platform-audit.js';
import { createRuntimeDb } from '../db/pool.js';
import type { Db } from '../db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../db/tenant-context.js';
import { createMetrics, type Metrics } from '../metrics.js';

import { createBoss, createJobClient, type JobClient } from './boss.js';
import { registerJobs, type WorkerLog } from './define-job.js';
import { listTenantIds } from './tenant-scan.js';
import { createDailyTicker, createTicker, type Ticker } from './ticker.js';

export interface WorkerOptions {
  databaseUrl: string;
  log: WorkerLog;
  metrics?: Metrics;
  /** How often new audit events are sealed. Defaults to 5 seconds (design, ADR-005). */
  sealIntervalMs?: number;
  /** See `SealOptions.graceMs`. */
  sealGraceMs?: number;
  /** Pg-boss polling interval. Defaults to 2 seconds. */
  pollingIntervalSeconds?: number;
  /** UTC hour of the nightly verification and partition upkeep. Defaults to 3. */
  nightlyHourUtc?: number;
}

export interface Worker {
  metrics: Metrics;
  stop(): Promise<void>;
}

/** Queues one job per tenant, inside that tenant's own transaction. */
export async function fanOut(
  db: Db,
  client: JobClient,
  queue: string,
  singleton: { singletonSeconds: number },
): Promise<number> {
  const withTenant = createWithTenant(db);
  const tenantIds = await listTenantIds(db);
  for (const tenantId of tenantIds) {
    await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
      client.enqueue(
        tx,
        queue,
        { tenantId },
        { singletonKey: tenantId, singletonSeconds: singleton.singletonSeconds },
      ),
    );
  }
  return tenantIds.length;
}

/**
 * Starts the `worker` role: the only process that registers job handlers. It seals audit events
 * every few seconds, and every night verifies every chain and makes sure the next audit
 * partitions exist.
 */
export async function startWorker(options: WorkerOptions): Promise<Worker> {
  const metrics = options.metrics ?? createMetrics();
  const handle = createRuntimeDb(options.databaseUrl);
  const boss = createBoss(options.databaseUrl, 'worker');
  const client = createJobClient(boss);

  await boss.start();
  const audit = createAuditJobs({
    metrics,
    log: options.log,
    ...(options.sealGraceMs === undefined ? {} : { graceMs: options.sealGraceMs }),
  });
  await registerJobs(
    boss,
    { db: handle.db, log: options.log },
    [audit.seal, audit.verify],
    options.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: options.pollingIntervalSeconds },
  );
  await ensureAuditPartitions(handle.db, { metrics });

  const report = (what: string) => (error: unknown) => {
    options.log.error(
      { what, code: (error as { code?: string } | null)?.code ?? 'unknown' },
      'scheduled task failed',
    );
  };

  const tickers: Ticker[] = [
    createTicker({
      intervalMs: options.sealIntervalMs ?? 5000,
      tick: async () => {
        await fanOut(handle.db, client, SEAL_JOB, { singletonSeconds: 5 });
      },
      onError: report('audit.seal tick'),
    }),
    // The platform's own trail is one global chain: sealed here, not by a per-tenant job.
    createTicker({
      intervalMs: options.sealIntervalMs ?? 5000,
      tick: async () => {
        await handle.db.transaction((tx) =>
          sealPlatformAudit(
            tx,
            options.sealGraceMs === undefined ? {} : { graceMs: options.sealGraceMs },
          ),
        );
      },
      onError: report('platform audit seal tick'),
    }),
    createDailyTicker({
      hourUtc: options.nightlyHourUtc ?? 3,
      tick: async () => {
        await ensureAuditPartitions(handle.db, { metrics });
        await fanOut(handle.db, client, VERIFY_JOB, { singletonSeconds: 3600 });
        const platform = await handle.db.transaction((tx) => verifyPlatformChain(tx));
        metrics.gauge('platform_audit_chain_verified_events', platform.verified);
        if (!platform.ok) {
          metrics.increment('platform_audit_chain_break_total');
          options.log.error(
            { firstBadSeq: platform.firstBadSeq, reason: platform.reason },
            'platform audit chain break',
          );
        }
      },
      onError: report('nightly audit tasks'),
    }),
  ];
  for (const ticker of tickers) ticker.start();

  return {
    metrics,
    async stop() {
      await Promise.all(tickers.map((ticker) => ticker.stop()));
      await boss.stop({ graceful: true, timeout: 10_000 });
      await handle.close();
    },
  };
}

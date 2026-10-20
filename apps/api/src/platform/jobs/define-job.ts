import type { RouteCategory } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import type { JobResult, PgBoss } from 'pg-boss';
import type { z } from 'zod';

import { jobExecution } from '../../db/schema/jobs.js';
import { tenant } from '../../db/schema/tenant.js';
import type { Db } from '../db/pool.js';
import { SYSTEM_USER_ID, createWithTenant, type Tx } from '../db/tenant-context.js';
import { jobMayRun } from '../read-only/jobs.js';

import type { JobPayload } from './boss.js';
import { JOB_LOCAL_CONCURRENCY } from './concurrency.js';

export interface JobInfo {
  id: string;
  name: string;
  /** When the job was enqueued. The read-only gate compares it with `read_only_since`. */
  enqueuedAt: Date;
  retryCount: number;
}

export interface JobContext<P extends JobPayload> {
  /** The transaction the handler runs in, already bound to the job's tenant. */
  tx: Tx;
  tenantId: string;
  payload: P;
  job: JobInfo;
}

export interface JobDefinition<P extends JobPayload = JobPayload> {
  name: string;
  /** Same categories as routes; decides whether the job runs for a read-only tenant. */
  category: RouteCategory;
  payload: z.ZodType<P>;
  handler(context: JobContext<P>): Promise<void>;
}

/** Declares a job. The wrapper in `runJob` supplies the tenant context, the gates and idempotence. */
export function defineJob<P extends JobPayload>(definition: JobDefinition<P>): JobDefinition<P> {
  return definition;
}

export type JobCancelReason =
  'tenant_read_only' | 'tenant_unverified' | 'tenant_not_found' | 'invalid_payload';

export type JobRunResult =
  | { status: 'completed' }
  /** The job id was already recorded as done: a redelivery, so the handler was not run again. */
  | { status: 'duplicate' }
  | { status: 'cancelled'; reason: JobCancelReason };

export interface RunJobInput extends JobInfo {
  data: unknown;
}

/**
 * Runs one delivery of a job:
 * 1. validates the payload (a malformed one is cancelled, not retried forever);
 * 2. opens `withTenant` for the payload's tenant, so row level security applies to the handler;
 * 3. re-checks the tenant's status NOW, not when the job was enqueued (read-only gate);
 * 4. records the job id in `job_execution` in the same transaction, and skips the handler when
 *    that id is already there (idempotent redelivery);
 * 5. runs the handler. If it throws, everything rolls back, the marker included, so a retry
 *    runs it again from scratch.
 */
export async function runJob<P extends JobPayload>(
  db: Db,
  definition: JobDefinition<P>,
  input: RunJobInput,
): Promise<JobRunResult> {
  const parsed = definition.payload.safeParse(input.data);
  if (!parsed.success) return { status: 'cancelled', reason: 'invalid_payload' };
  const payload = parsed.data;

  const withTenant = createWithTenant(db);
  return withTenant({ tenantId: payload.tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const [state] = await tx
      .select({ status: tenant.status, readOnlySince: tenant.readOnlySince })
      .from(tenant)
      .where(eq(tenant.id, payload.tenantId));
    if (!state) return { status: 'cancelled', reason: 'tenant_not_found' } as const;

    const decision = jobMayRun(
      definition,
      {
        status:
          state.status === 'read_only' ||
          state.status === 'cancelled' ||
          state.status === 'unverified'
            ? state.status
            : 'active',
        readOnlySince: state.readOnlySince,
      },
      input.enqueuedAt,
    );
    if (!decision.run) return { status: 'cancelled', reason: decision.reason } as const;

    const marked = await tx
      .insert(jobExecution)
      .values({ tenantId: payload.tenantId, queue: definition.name, jobId: input.id })
      .onConflictDoNothing()
      .returning({ id: jobExecution.id });
    if (marked.length === 0) return { status: 'duplicate' } as const;

    await definition.handler({
      tx,
      tenantId: payload.tenantId,
      payload,
      job: {
        id: input.id,
        name: input.name,
        enqueuedAt: input.enqueuedAt,
        retryCount: input.retryCount,
      },
    });
    return { status: 'completed' } as const;
  });
}

export interface WorkerLog {
  info(object: Record<string, unknown>, message: string): void;
  error(object: Record<string, unknown>, message: string): void;
}

/** Jobs fetched per poll. While batches come back full, the worker fetches again at once. */
const BATCH_SIZE = 20;

/**
 * Attaches the handlers to pg-boss. Call it only in the `worker` role: the API process never
 * registers handlers, so it can enqueue but never executes a job.
 *
 * Throughput matters here: audit sealing queues one job per tenant every few seconds, so a worker
 * that fetched one job per polling interval would fall behind as soon as there are a few dozen
 * tenants. Jobs are fetched in batches (`burstWhenBatchFull` keeps fetching while there is a
 * backlog) and settled one by one (`perJobResults`), so one failing job never fails its
 * neighbours.
 */
export async function registerJobs(
  boss: PgBoss,
  deps: { db: Db; log: WorkerLog },
  definitions: readonly JobDefinition[],
  options: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  for (const definition of definitions) {
    await boss.work(
      definition.name,
      {
        includeMetadata: true,
        pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
        batchSize: BATCH_SIZE,
        burstWhenBatchFull: true,
        perJobResults: true,
        localConcurrency: JOB_LOCAL_CONCURRENCY,
      },
      async (jobs) => {
        const results: JobResult[] = [];
        for (const job of jobs) {
          try {
            const result = await runJob(deps.db, definition, {
              id: job.id,
              name: job.name,
              data: job.data,
              enqueuedAt: job.createdOn,
              retryCount: job.retryCount,
            });
            if (result.status === 'cancelled') {
              deps.log.info(
                { job: definition.name, reason: result.reason },
                'job cancelled before running',
              );
              await boss.cancel(definition.name, job.id);
            }
            results.push({ id: job.id, status: 'completed' });
          } catch (error) {
            // pg-boss records the failure and retries it; this makes it visible in the logs too.
            // Only the error code is logged: messages can carry data.
            const cause = (error as { cause?: { code?: string }; code?: string } | null) ?? {};
            const code = cause.cause?.code ?? cause.code ?? 'unknown';
            deps.log.error(
              { job: definition.name, retryCount: job.retryCount, code },
              'job failed',
            );
            results.push({ id: job.id, status: 'failed', output: { code } });
          }
        }
        return results;
      },
    );
  }
}

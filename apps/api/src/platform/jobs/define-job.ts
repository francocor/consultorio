import type { RouteCategory } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { z } from 'zod';

import { jobExecution } from '../../db/schema/jobs.js';
import { tenant } from '../../db/schema/tenant.js';
import type { Db } from '../db/pool.js';
import { SYSTEM_USER_ID, createWithTenant, type Tx } from '../db/tenant-context.js';
import { jobMayRun } from '../read-only/jobs.js';

import type { JobPayload } from './boss.js';

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

export type JobCancelReason = 'tenant_read_only' | 'tenant_not_found' | 'invalid_payload';

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
          state.status === 'read_only' || state.status === 'cancelled' ? state.status : 'active',
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

/**
 * Attaches the handlers to pg-boss. Call it only in the `worker` role: the API process never
 * registers handlers, so it can enqueue but never executes a job.
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
      { includeMetadata: true, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 },
      async (jobs) => {
        for (const job of jobs) {
          const result = await runJob(deps.db, definition, {
            id: job.id,
            name: job.name,
            data: job.data,
            enqueuedAt: job.createdOn,
            retryCount: job.retryCount,
          }).catch((error: unknown) => {
            // pg-boss records the failure and retries; this makes it visible in the logs too.
            // Only the error code is logged: messages can carry data.
            const cause = (error as { cause?: { code?: string }; code?: string } | null) ?? {};
            deps.log.error(
              {
                job: definition.name,
                retryCount: job.retryCount,
                code: cause.cause?.code ?? cause.code ?? 'unknown',
              },
              'job failed',
            );
            throw error;
          });
          if (result.status === 'cancelled') {
            deps.log.info(
              { job: definition.name, reason: result.reason },
              'job cancelled before running',
            );
            await boss.cancel(definition.name, job.id);
          }
        }
      },
    );
  }
}

/** Row count helper kept next to the idempotence marker, for tests and housekeeping. */
export function countExecutions(tx: Tx, queue: string) {
  return tx.execute<{ n: number }>(
    sql`select count(*)::int as n from job_execution where queue = ${queue}`,
  );
}

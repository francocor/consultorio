import { sql } from 'drizzle-orm';
import { PgBoss, type SendOptions } from 'pg-boss';
import { z } from 'zod';

import { rawClientOf, type Tx } from '../db/tenant-context.js';

import { JOBS_SCHEMA } from './queues.js';

export type JobsRole = 'api' | 'worker';

/** Every job payload carries the tenant it belongs to, as the audit and tenancy rules require. */
export const JobPayload = z.looseObject({ tenantId: z.uuid() });
export type JobPayload = z.infer<typeof JobPayload>;

export type EnqueueOptions = Pick<
  SendOptions,
  'startAfter' | 'singletonKey' | 'singletonSeconds' | 'priority'
>;

/**
 * Builds the pg-boss instance of a process. The schema and the queues already exist (the installer
 * created them as the owner), so the runtime never migrates: a library whose schema version does
 * not match the database refuses to start, which is the signal to deploy the installer first.
 *
 * Only the `worker` role runs maintenance and ever registers handlers. The `api` role starts the
 * instance just to be able to enqueue; no worker is attached, so it never picks up a job.
 */
export function createBoss(databaseUrl: string, role: JobsRole): PgBoss {
  const boss = new PgBoss({
    connectionString: databaseUrl,
    schema: JOBS_SCHEMA,
    migrate: false,
    supervise: role === 'worker',
    schedule: false,
    max: role === 'worker' ? 6 : 2,
  });
  boss.on('error', () => undefined);
  return boss;
}

export interface JobClient {
  /**
   * Enqueues a job INSIDE the caller's transaction: if the business write rolls back, the job
   * never existed, and if it commits, the job is guaranteed to be queued (an outbox without a
   * separate table). The payload's `tenantId` must be the tenant of the transaction.
   */
  enqueue(
    tx: Tx,
    name: string,
    payload: JobPayload,
    options?: EnqueueOptions,
  ): Promise<string | null>;
}

export function createJobClient(boss: PgBoss): JobClient {
  return {
    async enqueue(tx, name, payload, options = {}) {
      const parsed = JobPayload.parse(payload);
      const current = await tx.execute<{ tenant: string | null }>(
        sql`select current_setting('app.tenant_id', true) as tenant`,
      );
      if (current.rows[0]?.tenant !== parsed.tenantId) {
        throw new Error('Job payload tenant does not match the transaction tenant');
      }

      const client = rawClientOf(tx);
      return boss.send(name, parsed, {
        ...options,
        db: { executeSql: (text, values) => client.query(text, values as unknown[]) },
      });
    },
  };
}

/**
 * A job client whose queue connects the first time something is enqueued, not when the process
 * boots. The API must start, and answer `/health`, without a database (`/ready` is the database
 * probe); a queue that connected at boot would take the process down with the database. A failed
 * start fails that enqueue (the request that asked for it gets an error) and is retried by the
 * next one.
 */
export interface LazyJobs {
  readonly client: JobClient;
  /** Stops the queue if it ever started. */
  stop(options?: Parameters<PgBoss['stop']>[0]): Promise<void>;
}

/** What the lazy client needs of the queue: a PgBoss, or a double with the same two methods. */
interface Startable {
  start(): Promise<unknown>;
  stop(options?: Parameters<PgBoss['stop']>[0]): Promise<unknown>;
}

export function createLazyJobs(boss: Startable, inner?: JobClient): LazyJobs {
  const real = inner ?? createJobClient(boss as PgBoss);
  let starting: Promise<unknown> | undefined;
  const started = () => {
    starting ??= boss.start().catch((error: unknown) => {
      starting = undefined;
      throw error;
    });
    return starting;
  };
  return {
    client: {
      async enqueue(tx, name, payload, options) {
        await started();
        return real.enqueue(tx, name, payload, options);
      },
    },
    async stop(options) {
      if (starting === undefined) return;
      await starting.catch(() => undefined);
      await boss.stop(options);
    },
  };
}

import type { PgBoss } from 'pg-boss';

/** PostgreSQL schema that holds the pg-boss tables. */
export const JOBS_SCHEMA = 'pgboss';

export type QueueOptions = NonNullable<Parameters<PgBoss['createQueue']>[1]>;

export interface QueueDefinition {
  name: string;
  options?: QueueOptions;
}

/**
 * The queues the application uses (design section 7, "Jobs"). pg-boss needs every queue to exist
 * before a job is sent to it, so the installer (`installJobs`, run by `db:migrate` as the owner)
 * creates them. A slice that adds a job adds its queue here.
 */
export const QUEUES: readonly QueueDefinition[] = [
  // Seals new audit events into the hash chain, one job per tenant every few seconds.
  { name: 'audit.seal', options: { retryLimit: 2, retryDelay: 5, expireInSeconds: 120 } },
  // Nightly re-walk of every tenant's chain.
  { name: 'audit.verify', options: { retryLimit: 1, retryDelay: 60, expireInSeconds: 1800 } },
  // Scans an uploaded document (sniff, hash, malware scan). A scanner that cannot be reached is not
  // a failure of the job: the job queues itself again with a delay, so the document stays
  // quarantined until it has really been scanned.
  { name: 'document.scan', options: { retryLimit: 3, retryDelay: 60, expireInSeconds: 600 } },
  // Marks uploads nobody confirmed as abandoned and removes their orphan objects.
  { name: 'document.cleanup', options: { retryLimit: 1, retryDelay: 300, expireInSeconds: 600 } },
];

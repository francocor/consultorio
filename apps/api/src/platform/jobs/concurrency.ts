/**
 * How many jobs of one kind a worker runs at once (`localConcurrency` of the queue handlers). The
 * size of the connection pool is derived from it (`MIN_DB_POOL_MAX` in the configuration): a job of
 * the families below holds two connections, so a pool smaller than that makes jobs wait on each other.
 */
export const JOB_LOCAL_CONCURRENCY = 2;

/**
 * The job families that keep the transaction `runJob` opens for them (the one that writes the marker
 * of idempotence) IDLE while they wait for something outside the database, and ask for a second
 * connection for the work they do meanwhile (JD-S4 R4-B-T5, JD-S5 R4-2):
 *
 * - `afip.issue`: the call to the authority; the mark of the attempt is committed on the second one;
 * - `erx.reconcile`: the questions to the e-prescription provider, one short transaction at a time;
 * - `portal.notice_sweep`: the messages of the notices, with the claim and the mark in short ones.
 *
 * Each family runs `JOB_LOCAL_CONCURRENCY` jobs at once, so the worker needs two connections for each
 * (`MIN_DB_POOL_MAX`). A new job that waits like these inside `defineJob` must be added here.
 */
export const CONNECTION_HOLDING_JOBS = [
  'afip.issue',
  'erx.reconcile',
  'portal.notice_sweep',
] as const;

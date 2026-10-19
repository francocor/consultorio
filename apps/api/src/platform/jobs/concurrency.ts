/**
 * How many jobs of one kind a worker runs at once (`localConcurrency` of the queue handlers). The
 * size of the connection pool is derived from it (`MIN_DB_POOL_MAX` in the configuration): an attempt
 * to issue an invoice holds two connections, so a pool smaller than that makes attempts wait on each
 * other.
 */
export const JOB_LOCAL_CONCURRENCY = 2;

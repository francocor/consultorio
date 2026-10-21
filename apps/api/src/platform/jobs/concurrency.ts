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
 * - `portal.notice_sweep`: the messages of the notices, with the claim and the mark in short ones;
 * - `subscription.reconcile`, `dunning.step` and `trial.end`: the questions to the payments provider,
 *   asked between two short transactions, with the mark of every write committed before its call
 *   (Stage 6, track A); `trial.end` asks the provider before a date moves an organization, like the
 *   dunning does (JD-S6 R1, A-W4);
 * - `usage.snapshot` and `statement.generate`: they do their work in short transactions of their own
 *   (`deps.withTenant`) and send the owner's email after them, with the framework's transaction idle
 *   meanwhile (JD-S6 R1, A-W4);
 * - `export.build`: the package of a cancelled organization, streamed to the files bucket while the
 *   lock of the build is held on the transaction of the framework (the reads are short ones of their own);
 * - `archive.write` and `archive.verify`: the write-once store, the same way.
 *
 * Each family runs `JOB_LOCAL_CONCURRENCY` jobs at once, so the worker needs two connections for each
 * (`MIN_DB_POOL_MAX`). A new job that waits like these inside `defineJob` must be added here.
 */
export const CONNECTION_HOLDING_JOBS = [
  'afip.issue',
  'erx.reconcile',
  'portal.notice_sweep',
  'subscription.reconcile',
  'dunning.step',
  'trial.end',
  'usage.snapshot',
  'statement.generate',
  'export.build',
  'archive.write',
  'archive.verify',
] as const;

/**
 * The families that wait on an outside service the same way but run in no worker, so they do not set
 * the floor of the worker pool (`MIN_DB_POOL_MAX`). `archive.release` runs only in the `releaser`
 * process, which has a pool of its own (the break-glass release of the archive, Stage 6 retention).
 *
 * A new job that waits like the families above is added to `CONNECTION_HOLDING_JOBS`, which raises
 * `MIN_DB_POOL_MAX`; then `DEFAULT_RUNTIME_POOL_MAX` (`platform/db/pool.ts`) is raised to at least
 * the new floor, with `DB_POOL_MAX` in `.env.example` (the maintainer's file: ask) and the numbers in
 * `docs/runbooks/deploy.md`, `config.test.ts` and `docs/security/asvs-l2-portal.md`.
 */
export const PENDING_CONNECTION_HOLDING_JOBS = ['archive.release'] as const;

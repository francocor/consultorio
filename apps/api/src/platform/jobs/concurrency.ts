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
  'export.build',
  'archive.write',
  'archive.verify',
] as const;

/**
 * The Stage 6 families that WILL wait for an outside service the same way (the payments gateway), whose
 * handlers do not exist yet. They are named now so that no track can add one and forget the pool, but
 * they are not in the list above because the floor of the pool rises with every family
 * (`MIN_DB_POOL_MAX`) and `.env.example` is the maintainer's file. The retention track (C) wrote its
 * three handlers and moved them above: the floor is 26 with them, so `.env.example` must say
 * `DB_POOL_MAX=26` or more. The track that writes one of these handlers:
 *
 * 1. writes it as the other families do: a short transaction for the mark before the call, none
 *    held while the call waits, a second one for the answer (never a provider call inside the
 *    transaction `runJob` opens, which idles for the length of the call);
 * 2. MOVES the name from this list to `CONNECTION_HOLDING_JOBS`, which raises `MIN_DB_POOL_MAX`;
 * 3. raises `DEFAULT_RUNTIME_POOL_MAX` (`platform/db/pool.ts`) to at least the new floor, `DB_POOL_MAX`
 *    in `.env.example` (the maintainer's file: ask) and the numbers in `docs/runbooks/deploy.md`,
 *    `config.test.ts` and `docs/security/asvs-l2-portal.md`.
 *
 * `archive.release` runs only in the `releaser` process, which has a pool of its own.
 */
export const PENDING_CONNECTION_HOLDING_JOBS = [
  'dunning.step',
  'subscription.reconcile',
  'archive.release',
] as const;

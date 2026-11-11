import { ARCHIVE_RELEASE_OPEN_DAYS } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { archiveReleaseRequest } from '../../../db/schema/archive-release.js';
import { createRuntimeDb } from '../../../platform/db/pool.js';
import {
  SYSTEM_USER_ID,
  createWithTenant,
  type WithTenant,
} from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import { createBoss, createJobClient, type JobClient } from '../../../platform/jobs/boss.js';
import { registerJobs, type WorkerLog } from '../../../platform/jobs/define-job.js';
import { createTicker } from '../../../platform/jobs/ticker.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import type { ObjectStorage } from '../../../platform/storage/object-storage.js';
import { createActionTokens } from '../../../platform/tokens/index.js';

import { createArchiveKeyReleaser } from './keys.js';
import type { ArchiveStore } from './ports.js';
import {
  ARCHIVE_RELEASE_JOB,
  createArchiveReleaseJob,
  packageKeyOf,
  redeliverRelease,
  type ArchiveReleaseDeps,
} from './release-archive.js';

/**
 * The `releaser` process role: the one process that holds `ARCHIVE_RELEASER_KEK` and therefore the
 * only one that can open the archive. It registers a single job, `archive.release`, looks every few
 * seconds for requests the operators approved, closes the requests nobody carried on for seven days,
 * and takes out of the bucket the packages whose link ended unused or whose release failed. It serves
 * no HTTP and has no audit sealer login: it is deliberately small, because what it holds is the key to
 * every cancelled organization's records.
 *
 * It connects as its own database role (`app_releaser`, `RELEASER_DATABASE_URL`), the only one that
 * may mark a request released, write the entries of a release, and ask what is waiting (migration
 * 0688). Every sweep it also writes its heartbeat, which the alert rules read (`releaser_heartbeat`):
 * a releaser that died is an alert, not a silence.
 *
 * Its connection pool is its own (a handful of connections: one release at a time per job slot).
 */

const SWEEP_LIMIT = 50;
/** Minutes a released request may wait for its email before the sweep sends it again. */
const UNSENT_AFTER_MINUTES = 10;
const DEFAULT_SWEEP_MS = 15_000;
const DEFAULT_POOL = 6;

export interface ReleaserOptions {
  /** The connection of the role `app_releaser` (`RELEASER_DATABASE_URL`). */
  databaseUrl: string;
  dbPoolMax?: number;
  /** The private half of the key of the releaser (32 bytes, base64). */
  kek: string;
  store: ArchiveStore;
  storage: ObjectStorage;
  email: EmailSender;
  origins: PublicOrigins;
  log: WorkerLog;
  clock?: () => Date;
  sweepEveryMs?: number;
  pollingIntervalSeconds?: number;
}

export interface Releaser {
  stop(): Promise<void>;
}

/**
 * Closes the requests that waited too long, queues `archive.release` for the approved ones and clears
 * the packages that should not be in the bucket (the link ended unused, or the release failed).
 */
export async function sweepReleases(deps: {
  db: ReturnType<typeof createRuntimeDb>['db'];
  withTenant: WithTenant;
  client: JobClient;
  storage: ObjectStorage;
  clock: () => Date;
  /** What it takes to send a link again (the releaser has it; a test of the sweep alone may not). */
  redeliver?: Pick<ArchiveReleaseDeps, 'tokens' | 'email' | 'origins'>;
}): Promise<{ queued: number; removed: number; expired: number; redelivered: number }> {
  const expired = await deps.db.transaction(async (tx) => {
    const result = await tx.execute<{ closed: number }>(
      sql`select app.archive_release_expire_stale(${ARCHIVE_RELEASE_OPEN_DAYS}) as closed`,
    );
    return result.rows[0]?.closed ?? 0;
  });
  const due = await deps.db.transaction(async (tx) => {
    const result = await tx.execute<{ request_id: string; tenant_id: string }>(
      sql`select * from app.archive_release_due(${SWEEP_LIMIT})`,
    );
    return result.rows;
  });
  for (const row of due) {
    await deps.withTenant({ tenantId: row.tenant_id, userId: SYSTEM_USER_ID }, (tx) =>
      deps.client.enqueue(
        tx,
        ARCHIVE_RELEASE_JOB,
        { tenantId: row.tenant_id, requestId: row.request_id },
        { singletonKey: `release:${row.request_id}`, singletonSeconds: 300 },
      ),
    );
  }

  const stale = await deps.db.transaction(async (tx) => {
    const result = await tx.execute<{ request_id: string; tenant_id: string }>(
      sql`select * from app.archive_release_cleanup_due(${SWEEP_LIMIT})`,
    );
    return result.rows;
  });
  let removed = 0;
  for (const row of stale) {
    const context = { tenantId: row.tenant_id, userId: SYSTEM_USER_ID };
    const key = await deps.withTenant(context, async (tx) => {
      const [found] = await tx
        .select({ key: archiveReleaseRequest.packageKey })
        .from(archiveReleaseRequest)
        .where(eq(archiveReleaseRequest.id, row.request_id));
      return found?.key ?? null;
    });
    // A failed or expired release has no key on its row, but it may have left the package in the bucket
    // under the name its id gives it: the removal of an object that is not there is not an error.
    await deps.storage.remove(row.tenant_id, key ?? packageKeyOf(row.tenant_id, row.request_id));
    await deps.withTenant(context, (tx) =>
      tx
        .update(archiveReleaseRequest)
        .set({ packageRemovedAt: deps.clock() })
        .where(eq(archiveReleaseRequest.id, row.request_id)),
    );
    removed += 1;
  }

  // A release whose email was lost (a crash between the row and the email): a new link goes out.
  let redelivered = 0;
  if (deps.redeliver) {
    const unsent = await deps.db.transaction(async (tx) => {
      const result = await tx.execute<{ request_id: string; tenant_id: string }>(
        sql`select * from app.archive_release_unsent(${UNSENT_AFTER_MINUTES}, ${SWEEP_LIMIT})`,
      );
      return result.rows;
    });
    for (const row of unsent) {
      const ok = await redeliverRelease(
        { ...deps.redeliver, withTenant: deps.withTenant, clock: deps.clock } as ArchiveReleaseDeps,
        { tenantId: row.tenant_id, userId: SYSTEM_USER_ID },
        row.request_id,
      ).catch(() => false);
      if (ok) redelivered += 1;
    }
  }
  return { queued: due.length, removed, expired, redelivered };
}

export async function createReleaser(options: ReleaserOptions): Promise<Releaser> {
  const clock = options.clock ?? (() => new Date());
  const handle = createRuntimeDb(options.databaseUrl, { max: options.dbPoolMax ?? DEFAULT_POOL });
  const boss = createBoss(options.databaseUrl, 'worker');
  const client = createJobClient(boss);
  await boss.start();

  const withTenant = createWithTenant(handle.db);
  const startedAt = clock();
  const tokens = createActionTokens({ clock });
  await registerJobs(
    boss,
    { db: handle.db, log: options.log },
    [
      createArchiveReleaseJob({
        withTenant,
        store: options.store,
        storage: options.storage,
        keys: createArchiveKeyReleaser({ kek: options.kek }),
        tokens,
        email: options.email,
        origins: options.origins,
        clock,
        log: options.log,
      }),
    ],
    options.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: options.pollingIntervalSeconds },
  );

  const ticker = createTicker({
    intervalMs: options.sweepEveryMs ?? DEFAULT_SWEEP_MS,
    tick: async () => {
      // First the heartbeat, so a sweep that fails halfway still says the process is alive.
      await handle.db.execute(
        sql`select app.releaser_beat(${startedAt.toISOString()}::timestamptz)`,
      );
      await sweepReleases({
        db: handle.db,
        withTenant,
        client,
        storage: options.storage,
        clock,
        redeliver: { tokens, email: options.email, origins: options.origins },
      });
    },
    onError: (error) => {
      options.log.error(
        { what: 'release sweep', code: (error as { code?: string } | null)?.code ?? 'unknown' },
        'scheduled task failed',
      );
    },
  });
  // Alive from the first second, not from the first sweep.
  await handle.db.execute(sql`select app.releaser_beat(${startedAt.toISOString()}::timestamptz)`);
  ticker.start();

  return {
    async stop() {
      await ticker.stop();
      await boss.stop({ graceful: true, timeout: 10_000 });
      await handle.close();
    },
  };
}

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
import { ARCHIVE_RELEASE_JOB, createArchiveReleaseJob } from './release-archive.js';

/**
 * The `releaser` process role: the one process that holds `ARCHIVE_RELEASER_KEK` and therefore the
 * only one that can open the archive. It registers a single job, `archive.release`, looks every few
 * seconds for requests the operators approved, and takes out of the bucket the packages whose link
 * ended unused. It serves no HTTP and has no audit sealer login: it is deliberately small, because what
 * it holds is the key to every cancelled organization's records.
 *
 * Its connection pool is its own (a handful of connections: one release at a time per job slot).
 */

const SWEEP_LIMIT = 50;
const DEFAULT_SWEEP_MS = 15_000;
const DEFAULT_POOL = 6;

export interface ReleaserOptions {
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

/** Queues `archive.release` for the approved requests and clears the packages whose link ended. */
export async function sweepReleases(deps: {
  db: ReturnType<typeof createRuntimeDb>['db'];
  withTenant: WithTenant;
  client: JobClient;
  storage: ObjectStorage;
  clock: () => Date;
}): Promise<{ queued: number; removed: number }> {
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
    if (key !== null) await deps.storage.remove(row.tenant_id, key);
    await deps.withTenant(context, (tx) =>
      tx
        .update(archiveReleaseRequest)
        .set({ packageRemovedAt: deps.clock() })
        .where(eq(archiveReleaseRequest.id, row.request_id)),
    );
    removed += 1;
  }
  return { queued: due.length, removed };
}

export async function createReleaser(options: ReleaserOptions): Promise<Releaser> {
  const clock = options.clock ?? (() => new Date());
  const handle = createRuntimeDb(options.databaseUrl, { max: options.dbPoolMax ?? DEFAULT_POOL });
  const boss = createBoss(options.databaseUrl, 'worker');
  const client = createJobClient(boss);
  await boss.start();

  const withTenant = createWithTenant(handle.db);
  await registerJobs(
    boss,
    { db: handle.db, log: options.log },
    [
      createArchiveReleaseJob({
        withTenant,
        store: options.store,
        storage: options.storage,
        keys: createArchiveKeyReleaser({ kek: options.kek }),
        tokens: createActionTokens({ clock }),
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
      await sweepReleases({ db: handle.db, withTenant, client, storage: options.storage, clock });
    },
    onError: (error) => {
      options.log.error(
        { what: 'release sweep', code: (error as { code?: string } | null)?.code ?? 'unknown' },
        'scheduled task failed',
      );
    },
  });
  ticker.start();

  return {
    async stop() {
      await ticker.stop();
      await boss.stop({ graceful: true, timeout: 10_000 });
      await handle.close();
    },
  };
}

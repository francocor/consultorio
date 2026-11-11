import { sql } from 'drizzle-orm';

import type { Db } from '../../../platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';

import { ARCHIVE_VERIFY_JOB } from './verify-archive.js';
import { ARCHIVE_WRITE_JOB } from './write-archive.js';

/**
 * The clocks of the archive: every few minutes the worker asks which organizations are due to be
 * archived (their export window is over) or verified (never verified, or not for a week) and queues
 * the job for each. The questions are definer functions that return tenant ids and nothing else
 * (migration 0653); the job is queued inside a transaction of the organization it is for. Queuing the
 * same organization twice is harmless: the jobs hold a lock per organization and each one checks the
 * state again when it runs.
 */

const SWEEP_LIMIT = 50;

async function dueTenants(db: Db, fn: 'archive_due' | 'archive_verify_due', days: number) {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{ tenant_id: string }>(
      fn === 'archive_due'
        ? sql`select app.archive_due(${days}, ${SWEEP_LIMIT}) as tenant_id`
        : sql`select app.archive_verify_due(${days}, ${SWEEP_LIMIT}) as tenant_id`,
    );
    return result.rows.map((row) => row.tenant_id);
  });
}

async function queueFor(
  db: Db,
  client: JobClient,
  queue: string,
  tenantIds: readonly string[],
  singletonSeconds: number,
): Promise<number> {
  const withTenant = createWithTenant(db);
  for (const tenantId of tenantIds) {
    await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
      client.enqueue(
        tx,
        queue,
        { tenantId },
        { singletonKey: `${queue}:${tenantId}`, singletonSeconds },
      ),
    );
  }
  return tenantIds.length;
}

export async function enqueueDueArchives(
  db: Db,
  client: JobClient,
  options: { afterDays: number },
): Promise<number> {
  return queueFor(
    db,
    client,
    ARCHIVE_WRITE_JOB,
    await dueTenants(db, 'archive_due', options.afterDays),
    300,
  );
}

export async function enqueueDueVerifications(
  db: Db,
  client: JobClient,
  options: { everyDays: number },
): Promise<number> {
  return queueFor(
    db,
    client,
    ARCHIVE_VERIFY_JOB,
    await dueTenants(db, 'archive_verify_due', options.everyDays),
    300,
  );
}

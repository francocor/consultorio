import { sql } from 'drizzle-orm';

import { audit } from '../../../platform/audit/writer.js';
import type { Db } from '../../../platform/db/pool.js';
import { SYSTEM_USER_ID, createWithTenant, type Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { TenantCancelledEvent, TenantLifecycle } from '../application/lifecycle.js';

import { CANCELLATION_EXPORT_JOB } from './build-export.js';
import { requestAdministrativePackage } from './packages.js';

/**
 * How the end of an organization reaches the job that makes its export.
 *
 * `TenantCancelled` is delivered inside the transaction that cancelled, and that transaction is not
 * always the application's: the operator's cancellation runs on the operator connection, which has
 * no right on the job queue (and should not: it could queue any job for any organization). So the
 * subscriber does not queue anything. It writes the REQUEST, the administrative package in state
 * `queued`, and the worker looks for requests now and then (`enqueuePendingExports`). The request
 * survives a crash, a redelivery of the event finds it again (unique per organization), and nothing
 * outside the database is called from the cancelling transaction.
 */

/** The actor of an entry written by the system itself. */
const SYSTEM_ACTOR = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
} as const;

/** What the subscriber does for one cancellation. Idempotent per organization. */
export async function requestCancellationExport(
  tx: Tx,
  event: TenantCancelledEvent,
): Promise<void> {
  const id = await requestAdministrativePackage(tx);
  // A redelivered event finds the request and writes nothing more.
  if (id === null) return;
  await audit(tx, {
    action: 'export.cancellation.requested',
    outcome: 'allow',
    actor: SYSTEM_ACTOR,
    resourceType: 'export_package',
    resourceId: id,
    metadata: { kind: 'administrative', source: event.source },
  });
}

/** Subscribes the cancellation export to the end of an organization. Returns how to unsubscribe. */
export function subscribeCancellationExport(lifecycle: TenantLifecycle): () => void {
  return lifecycle.onCancelled(requestCancellationExport);
}

/** How many organizations one sweep looks at. */
const SWEEP_LIMIT = 50;
/** A queued job for an organization is not queued again for this long. */
const SWEEP_SINGLETON_SECONDS = 120;

/**
 * Queues `export.build` for every organization that has a package waiting. The scan is a definer
 * function that returns tenant ids and nothing else (migration 0651); the job is queued inside a
 * transaction of the organization it is for.
 */
export async function enqueuePendingExports(db: Db, client: JobClient): Promise<number> {
  const found = await db.transaction(async (tx) => {
    const result = await tx.execute<{ tenant_id: string }>(
      sql`select app.cancellation_export_pending(${SWEEP_LIMIT}) as tenant_id`,
    );
    return result.rows.map((row) => row.tenant_id);
  });
  const withTenant = createWithTenant(db);
  for (const tenantId of found) {
    await withTenant({ tenantId, userId: SYSTEM_USER_ID }, (tx) =>
      client.enqueue(
        tx,
        CANCELLATION_EXPORT_JOB,
        { tenantId, reason: 'cancellation' },
        { singletonKey: `${tenantId}:cancellation`, singletonSeconds: SWEEP_SINGLETON_SECONDS },
      ),
    );
  }
  return found.length;
}

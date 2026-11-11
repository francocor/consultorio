import { and, eq, isNull, sql } from 'drizzle-orm';

import { exportPackage } from '../../../db/schema/export-package.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Db } from '../../../platform/db/pool.js';
import {
  SYSTEM_USER_ID,
  type RequestContext,
  type WithTenant,
} from '../../../platform/db/tenant-context.js';
import type { ObjectStorage } from '../../../platform/storage/object-storage.js';

import { SYSTEM_ACTOR } from './queue.js';

/**
 * The packages of the cancellation export are plain zips in the bucket of the organization. They have a
 * purpose (the owner and the professionals download them during the window) and then the archive takes
 * over: encrypted, write-once and verified. Keeping the plain copy for ever would leave readable records
 * of a cancelled organization behind, outside every control of the archive (JD-S6 R1-A-W7).
 *
 * A package is removed when BOTH are true: the download window (`afterDays` from the request of the
 * export) is over, AND the archive of the organization is written and its last verification was `ok`
 * (`app.export_cleanup_due`). The object goes first and the row records it (`object_removed_at`) with an
 * entry in the trail of the organization; a run that dies in between finds the package again and removes
 * an object that is already gone, which is not an error. The row stays: it says there was a package.
 */

const PASS_SIZE = 50;

export interface ExportCleanupDeps {
  db: Db;
  withTenant: WithTenant;
  storage: ObjectStorage;
  clock: () => Date;
  /** The same days as the archive waits after the cancellation (`ARCHIVE_AFTER_DAYS`). */
  afterDays: number;
}

/** Removes the plain packages that have been replaced by a verified archive. Returns how many. */
export async function removeSpentExports(deps: ExportCleanupDeps): Promise<number> {
  const due = await deps.db.transaction((tx) =>
    tx.execute<{ app_export_cleanup_due: string }>(
      sql`select app.export_cleanup_due(${deps.afterDays}, ${PASS_SIZE}) as app_export_cleanup_due`,
    ),
  );
  let removed = 0;
  let failures = 0;
  for (const row of due.rows) {
    const tenantId = row.app_export_cleanup_due;
    const system: RequestContext = { tenantId, userId: SYSTEM_USER_ID };
    try {
      const packages = await deps.withTenant(system, (tx) =>
        tx
          .select()
          .from(exportPackage)
          .where(and(eq(exportPackage.status, 'ready'), isNull(exportPackage.objectRemovedAt))),
      );
      for (const found of packages) {
        if (found.objectKey === null) continue;
        await deps.storage.remove(tenantId, found.objectKey);
        await deps.withTenant(system, async (tx) => {
          const marked = await tx
            .update(exportPackage)
            .set({ objectRemovedAt: deps.clock() })
            .where(and(eq(exportPackage.id, found.id), isNull(exportPackage.objectRemovedAt)))
            .returning({ id: exportPackage.id });
          if (marked.length === 0) return;
          await audit(tx, {
            action: 'export.cancellation.removed',
            outcome: 'allow',
            actor: SYSTEM_ACTOR,
            resourceType: 'export_package',
            resourceId: found.id,
            metadata: { kind: found.kind },
          });
          removed += 1;
        });
      }
    } catch {
      // One organization must not keep the others from being cleaned: count it and go on.
      failures += 1;
    }
  }
  if (failures > 0) {
    throw new Error(`the plain export of ${String(failures)} organizations could not be removed`);
  }
  return removed;
}

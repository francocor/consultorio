import { and, eq, isNotNull, isNull, lt } from 'drizzle-orm';

import { document } from '../../../db/schema/documents.js';
import { JobPayload, type JobClient } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import type { ObjectStorage } from '../../../platform/storage/object-storage.js';

import { SCAN_JOB } from './uploads.js';

export const CLEANUP_JOB = 'document.cleanup';

/** An upload nobody confirmed within this long is abandoned. */
const ABANDON_AFTER_MS = 24 * 3_600_000;
/** A confirmed upload still quarantined with no activity for this long has probably lost its job. */
const RESCUE_AFTER_MS = 30 * 60_000;

export interface CleanupDeps {
  storage: ObjectStorage;
  jobs: JobClient;
  clock: () => Date;
}

/**
 * Housekeeping for one organization (documents, "Duplicate detection and interrupted uploads").
 *
 * - An upload that was requested but never confirmed leaves a row nobody sees. After a day the row
 *   is MARKED abandoned (it is never deleted: documents are never removed from the table) and its
 *   orphan object, if the browser got that far, is removed from storage.
 * - A confirmed upload that is still quarantined and has seen no activity for half an hour gets its
 *   scan queued again, so a lost job cannot leave a file waiting with nobody looking at it.
 */
export function createCleanupJob(deps: CleanupDeps) {
  return defineJob({
    name: CLEANUP_JOB,
    // Housekeeping can wait for a read-only organization to recover; nothing is lost meanwhile.
    category: 'write',
    payload: JobPayload,
    handler: async ({ tx, tenantId }) => {
      const now = deps.clock();

      const stale = await tx
        .select({ id: document.id, objectKey: document.objectKey })
        .from(document)
        .where(
          and(
            isNull(document.uploadCompletedAt),
            isNull(document.abandonedAt),
            lt(document.createdAt, new Date(now.getTime() - ABANDON_AFTER_MS)),
          ),
        );
      for (const row of stale) {
        await tx.update(document).set({ abandonedAt: now }).where(eq(document.id, row.id));
        await deps.storage.remove(tenantId, row.objectKey);
      }

      const lost = await tx
        .select({ id: document.id })
        .from(document)
        .where(
          and(
            isNotNull(document.uploadCompletedAt),
            // Only the ones still waiting for their scan.
            eq(document.status, 'quarantined'),
            lt(document.updatedAt, new Date(now.getTime() - RESCUE_AFTER_MS)),
          ),
        );
      for (const row of lost) {
        await deps.jobs.enqueue(
          tx,
          SCAN_JOB,
          { tenantId, documentId: row.id },
          { singletonKey: row.id, singletonSeconds: 1800 },
        );
      }
    },
  });
}

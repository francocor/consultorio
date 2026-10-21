import { and, eq, isNull } from 'drizzle-orm';

import { archiveReleaseRequest } from '../../../db/schema/archive-release.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';

import { writeDownloadAudit } from './archive-state.js';

/**
 * The download of a released package (JD-S6 R1-S6-8). The link is single use, but it is spent when the
 * transfer ENDS and not when it starts: a download that breaks halfway (a phone that lost the signal)
 * does not burn the only copy of the records.
 *
 * - **Claim.** Before a byte is sent the request takes a lease (`download_started_at`) and counts an
 *   attempt. A lease that is held (another download in progress, for at most ten minutes) or five
 *   attempts used refuse the next one, so the retries are bounded and two downloads never run at once.
 *   The link is NOT redeemed yet.
 * - **Complete.** When the response ended the link is redeemed, the request records `downloaded_at`
 *   and the entry of the platform trail, and the caller takes the package out of the bucket.
 * - **Abandon.** When the response broke, the lease is released and the attempt stays counted; the
 *   link still works until it ends.
 */

/** The most times the link is tried in its life (it is a package of records: a few, not a loop). */
export const MAX_DOWNLOAD_ATTEMPTS = 5;
/** How long a download in progress holds the link before another may start. */
export const DOWNLOAD_LEASE_MS = 10 * 60_000;

export interface ClaimedDownload {
  id: string;
  /** Where the package waits. */
  key: string;
}

/** Takes the lease of the download for the link, or answers null (the link is not usable now). */
export async function claimDownload(
  tx: Tx,
  tokens: ActionTokens,
  token: string,
  now: Date,
): Promise<ClaimedDownload | null> {
  const inspected = await tokens.inspect(tx, 'archive_release', token);
  if (!inspected) return null;
  const [row] = await tx
    .select()
    .from(archiveReleaseRequest)
    .where(
      and(
        eq(archiveReleaseRequest.id, inspected.subjectId),
        eq(archiveReleaseRequest.status, 'released'),
      ),
    )
    .for('update');
  if (
    !row ||
    row.packageKey === null ||
    row.downloadedAt !== null ||
    !row.linkExpiresAt ||
    row.linkExpiresAt.getTime() < now.getTime() ||
    row.downloadAttempts >= MAX_DOWNLOAD_ATTEMPTS ||
    (row.downloadStartedAt !== null &&
      row.downloadStartedAt.getTime() > now.getTime() - DOWNLOAD_LEASE_MS)
  ) {
    return null;
  }
  await tx
    .update(archiveReleaseRequest)
    .set({ downloadStartedAt: now, downloadAttempts: row.downloadAttempts + 1 })
    .where(eq(archiveReleaseRequest.id, row.id));
  return { id: row.id, key: row.packageKey };
}

/** The transfer ended: spends the link, records the download and writes its entry of the trail. */
export async function completeDownload(
  tx: Tx,
  tokens: ActionTokens,
  token: string,
  id: string,
  now: Date,
): Promise<boolean> {
  const redeemed = await tokens.redeem(tx, 'archive_release', token);
  if (!redeemed || redeemed.subjectId !== id) return false;
  const marked = await tx
    .update(archiveReleaseRequest)
    .set({ downloadedAt: now, downloadStartedAt: null })
    .where(and(eq(archiveReleaseRequest.id, id), isNull(archiveReleaseRequest.downloadedAt)))
    .returning({ id: archiveReleaseRequest.id });
  if (marked.length === 0) return false;
  await writeDownloadAudit(tx, id);
  return true;
}

/** The transfer broke: the lease is released so the link can be tried again (the attempt stays counted). */
export async function abandonDownload(tx: Tx, id: string): Promise<void> {
  await tx
    .update(archiveReleaseRequest)
    .set({ downloadStartedAt: null })
    .where(and(eq(archiveReleaseRequest.id, id), isNull(archiveReleaseRequest.downloadedAt)));
}

import { and, asc, eq, isNotNull } from 'drizzle-orm';

import { videoSession } from '../../../db/schema/teleconsultation.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { sealManualLink } from './video-state.js';

/** Sessions looked at per run: the sweep comes back every hour. */
const BATCH = 200;

/**
 * Moves the manual links written in plaintext, before links were encrypted, to their encrypted
 * form (judgment day round 2, finding C7). Until now a legacy link was sealed only when somebody
 * followed it, so one nobody followed rested in plaintext for ever; a manual link can carry a
 * passcode. A session that is closed can no longer be joined, so its link is dropped outright
 * instead of being kept encrypted for nothing. Returns how many rows it changed. Safe to run again.
 */
export async function sealLegacyManualLinks(
  tx: Tx,
  keys: TenantKeys,
  options: { batch?: number } = {},
): Promise<number> {
  const rows = await tx
    .select()
    .from(videoSession)
    .where(isNotNull(videoSession.manualLink))
    .orderBy(asc(videoSession.createdAt), asc(videoSession.id))
    .limit(options.batch ?? BATCH);
  for (const row of rows) {
    const url = row.manualLink;
    if (url === null) continue;
    // Closed: nobody can join, so the link is dropped outright, in plaintext and sealed form alike.
    // Any other session keeps the sealed form it already had, or gets one from the plaintext.
    const sealed =
      row.status === 'closed'
        ? null
        : (row.manualLinkEnc ?? (await sealManualLink(tx, keys, row.id, url)));
    await tx
      .update(videoSession)
      .set({ manualLink: null, manualLinkEnc: sealed })
      .where(and(isNotNull(videoSession.manualLink), eq(videoSession.id, row.id)));
  }
  return rows.length;
}

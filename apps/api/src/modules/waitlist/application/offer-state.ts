import type { WaitlistOfferEndReason } from '@consultorio/contracts';
import { and, eq, inArray, type SQL } from 'drizzle-orm';

import {
  waitlistEntry,
  waitlistOffer,
  type WaitlistOfferRow,
} from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * Ends the open offers that match `where`, as invalidated and with the reason. Invalidating is
 * what happens to an offer nobody answered when the world moved on: the slot was taken, the entry
 * was closed or paused, the patient opted out. The entries that were waiting for an answer go back
 * to waiting (a caller that closes or pauses the entry sets that status afterwards). Returns the
 * offers it ended, so the caller can offer their slots to the next entry.
 */
export async function invalidateOpenOffers(
  tx: Tx,
  where: SQL | undefined,
  input: { reason: WaitlistOfferEndReason; now: Date },
): Promise<WaitlistOfferRow[]> {
  const ended = await tx
    .update(waitlistOffer)
    .set({ status: 'invalidated', endReason: input.reason, closedAt: input.now })
    .where(and(eq(waitlistOffer.status, 'open'), where))
    .returning();
  if (ended.length > 0) {
    await tx
      .update(waitlistEntry)
      .set({ status: 'active' })
      .where(
        and(
          inArray(
            waitlistEntry.id,
            ended.map((offer) => offer.entryId),
          ),
          eq(waitlistEntry.status, 'offered'),
        ),
      );
  }
  return ended;
}

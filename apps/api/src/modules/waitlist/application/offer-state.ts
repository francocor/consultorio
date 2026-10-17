import type { WaitlistOfferEndReason } from '@consultorio/contracts';
import { and, eq, type SQL } from 'drizzle-orm';

import { waitlistOffer, type WaitlistOfferRow } from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * Ends the open offers that match `where`, as invalidated and with the reason. Invalidating is
 * what happens to an offer nobody answered when the world moved on: the slot was taken, the entry
 * was closed or paused, the patient opted out. Returns the offers it ended, so the caller can offer
 * their slots to the next entry.
 */
export async function invalidateOpenOffers(
  tx: Tx,
  where: SQL | undefined,
  input: { reason: WaitlistOfferEndReason; now: Date },
): Promise<WaitlistOfferRow[]> {
  return tx
    .update(waitlistOffer)
    .set({ status: 'invalidated', endReason: input.reason, closedAt: input.now })
    .where(and(eq(waitlistOffer.status, 'open'), where))
    .returning();
}

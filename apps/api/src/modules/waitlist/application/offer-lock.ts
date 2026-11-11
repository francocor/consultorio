import { and, eq, inArray } from 'drizzle-orm';

import { waitlistOffer, type WaitlistOfferRow } from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { SchedulingPorts } from '../../scheduling/index.js';

/**
 * The order in which the waitlist takes locks, the same everywhere, so two writers never wait for
 * each other. A booking takes the professional first (design 4.6) and, through the appointment
 * events, then the open offers it ends and the entries they belong to. Everything here follows:
 * the professional, then the offers, then the entries.
 */

/** Locks one offer, after the professional it is for. Null when there is no such offer. */
export async function lockOffer(
  tx: Tx,
  ports: SchedulingPorts,
  offerId: string,
): Promise<WaitlistOfferRow | null> {
  const [peek] = await tx
    .select({ professionalId: waitlistOffer.professionalId })
    .from(waitlistOffer)
    .where(eq(waitlistOffer.id, offerId));
  if (!peek) return null;
  await ports.lockProfessional(peek.professionalId);
  const [offer] = await tx
    .select()
    .from(waitlistOffer)
    .where(eq(waitlistOffer.id, offerId))
    .for('update');
  return offer ?? null;
}

/** Locks the open offers of these entries, before the entries themselves are locked. */
export async function lockOpenOffersOf(tx: Tx, entryIds: readonly string[]): Promise<void> {
  if (entryIds.length === 0) return;
  await tx
    .select({ id: waitlistOffer.id })
    .from(waitlistOffer)
    .where(and(inArray(waitlistOffer.entryId, [...entryIds]), eq(waitlistOffer.status, 'open')))
    .orderBy(waitlistOffer.id)
    .for('update');
}

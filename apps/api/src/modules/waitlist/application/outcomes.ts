import { and, gte, lt, sql } from 'drizzle-orm';

import { waitlistOffer } from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

export interface WaitlistOutcomes {
  /** Offers made in the period. */
  offers: number;
  accepted: number;
  declined: number;
  expired: number;
  /** Ended without an answer because the slot, the entry or the patient changed. */
  invalidated: number;
  /** Slots recovered: offers accepted that became an appointment. */
  recoveredSlots: number;
  /** Offers the patient answered (accepted or declined). */
  answeredOffers: number;
  /** How long patients take to answer, from the offer to the answer; 0 when none was answered. */
  averageResponseSeconds: number;
}

/**
 * What the offers of a period came to (waitlist, "Fairness, audit and metrics"): the numbers the
 * reports of recovered slots read. It reads the offers as they were stored, nothing else: when each
 * one was made and closed, how it ended and the appointment it became. Offers created in
 * `[from, to)` count.
 */
export async function waitlistOutcomes(
  tx: Tx,
  period: { from: Date; to: Date },
): Promise<WaitlistOutcomes> {
  const [row] = await tx
    .select({
      offers: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${waitlistOffer.status} = 'accepted')::int`,
      declined: sql<number>`count(*) filter (where ${waitlistOffer.status} = 'declined')::int`,
      expired: sql<number>`count(*) filter (where ${waitlistOffer.status} = 'expired')::int`,
      invalidated: sql<number>`count(*) filter (where ${waitlistOffer.status} = 'invalidated')::int`,
      recovered: sql<number>`count(*) filter (where ${waitlistOffer.status} = 'accepted' and ${waitlistOffer.appointmentId} is not null)::int`,
      answered: sql<number>`count(*) filter (where ${waitlistOffer.status} in ('accepted', 'declined'))::int`,
      seconds: sql<
        number | null
      >`avg(extract(epoch from (${waitlistOffer.closedAt} - ${waitlistOffer.createdAt}))) filter (where ${waitlistOffer.status} in ('accepted', 'declined'))::float8`,
    })
    .from(waitlistOffer)
    .where(and(gte(waitlistOffer.createdAt, period.from), lt(waitlistOffer.createdAt, period.to)));
  return {
    offers: row?.offers ?? 0,
    accepted: row?.accepted ?? 0,
    declined: row?.declined ?? 0,
    expired: row?.expired ?? 0,
    invalidated: row?.invalidated ?? 0,
    recoveredSlots: row?.recovered ?? 0,
    answeredOffers: row?.answered ?? 0,
    averageResponseSeconds: Math.round(row?.seconds ?? 0),
  };
}

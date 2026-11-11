import { WAITLIST_FLAG_AFTER_EXPIRED } from '@consultorio/contracts';
import { and, eq, lte } from 'drizzle-orm';

import { waitlistEntry, waitlistOffer } from '../../../db/schema/waitlist.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';

import { closeExpiredEntries } from './entries.js';
import { SYSTEM_ACTOR } from './offers.js';
import { enqueueRematch } from './trigger.js';

/** The most offers one sweep closes. The next sweep takes the rest. */
const SWEEP_LIMIT = 100;

/**
 * Closes an offer whose time ran out without an answer (waitlist, "Offers with expiry"): the offer
 * is `expired`, the entry goes back to waiting with one more offer that went unanswered (at three
 * in a row it is flagged for reception), the expiry is audited and the next entry in line gets the
 * slot. An offer that is not open, or whose time has not come, is left alone, so a repeated or
 * early job does nothing. Returns whether it closed the offer.
 */
export async function expireOffer(
  tx: Tx,
  deps: { jobs: JobClient },
  input: { offerId: string; now: Date },
): Promise<boolean> {
  const [offer] = await tx
    .select()
    .from(waitlistOffer)
    .where(eq(waitlistOffer.id, input.offerId))
    .for('update');
  if (offer?.status !== 'open' || offer.expiresAt.getTime() > input.now.getTime()) return false;

  await tx
    .update(waitlistOffer)
    .set({ status: 'expired', closedAt: input.now })
    .where(eq(waitlistOffer.id, offer.id));
  const [entry] = await tx
    .select()
    .from(waitlistEntry)
    .where(eq(waitlistEntry.id, offer.entryId))
    .for('update');
  if (entry) {
    const unanswered = entry.consecutiveExpired + 1;
    await tx
      .update(waitlistEntry)
      .set({
        consecutiveExpired: unanswered,
        ...(unanswered >= WAITLIST_FLAG_AFTER_EXPIRED && entry.flaggedAt === null
          ? { flaggedAt: input.now }
          : {}),
        ...(entry.status === 'offered' ? { status: 'active' } : {}),
      })
      .where(eq(waitlistEntry.id, entry.id));
  }
  await audit(tx, {
    action: 'waitlist.offer.expired',
    outcome: 'allow',
    actor: SYSTEM_ACTOR,
    resourceType: 'waitlist_offer',
    resourceId: offer.id,
    patientId: offer.patientId,
    metadata: { entryId: offer.entryId, startsAt: offer.startsAt.toISOString() },
  });
  await enqueueRematch(tx, deps.jobs, [offer]);
  return true;
}

/**
 * The minutely sweep of an organization: closes every offer that is due (a backup for the job
 * queued at the exact expiry) and every entry whose time ran out. Returns how many of each.
 */
export async function sweepWaitlist(
  tx: Tx,
  deps: { jobs: JobClient },
  input: { now: Date },
): Promise<{ offers: number; entries: number }> {
  const due = await tx
    .select({ id: waitlistOffer.id })
    .from(waitlistOffer)
    .where(and(eq(waitlistOffer.status, 'open'), lte(waitlistOffer.expiresAt, input.now)))
    .limit(SWEEP_LIMIT);
  let offers = 0;
  for (const offer of due) {
    if (await expireOffer(tx, deps, { offerId: offer.id, now: input.now })) offers += 1;
  }
  const entries = await closeExpiredEntries(tx, { now: input.now, jobs: deps.jobs });
  return { offers, entries };
}

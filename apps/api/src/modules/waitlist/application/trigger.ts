import { and, eq, gt, lt } from 'drizzle-orm';

import { waitlistOffer, type WaitlistOfferRow } from '../../../db/schema/waitlist.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import type {
  SlotFreedCause,
  AppointmentEvent,
  AppointmentFacts,
} from '../../../platform/events/appointment-events.js';
import type { JobClient } from '../../../platform/jobs/boss.js';

import { invalidateOpenOffers } from './offer-state.js';

export const WAITLIST_MATCH_JOB = 'waitlist.match';

/** What made the match run: a slot came free, or an offer for one ended and the next entry is due. */
export type MatchCause = SlotFreedCause | 'offer_ended';

export interface FreedRange {
  professionalId: string | null;
  locationId: string | null;
  startsAt: Date;
  endsAt: Date;
}

/** Queues the match of a freed range, in the transaction that frees it (or ends the offer). */
export async function enqueueMatch(
  tx: Tx,
  jobs: JobClient,
  range: FreedRange,
  cause: MatchCause,
): Promise<void> {
  await jobs.enqueue(tx, WAITLIST_MATCH_JOB, {
    tenantId: await currentTenantId(tx),
    professionalId: range.professionalId,
    locationId: range.locationId,
    startsAt: range.startsAt.toISOString(),
    endsAt: range.endsAt.toISOString(),
    cause,
  });
}

/** The offers that ended without a booking free their slot for the next entry in line. */
export async function enqueueRematch(
  tx: Tx,
  jobs: JobClient | undefined,
  offers: readonly WaitlistOfferRow[],
): Promise<void> {
  if (!jobs) return;
  for (const offer of offers) {
    await enqueueMatch(
      tx,
      jobs,
      {
        professionalId: offer.professionalId,
        locationId: offer.locationId,
        startsAt: offer.freedStartsAt,
        endsAt: offer.freedEndsAt,
      },
      'offer_ended',
    );
  }
}

/** The open offers of the professional that overlap the range an appointment now takes. */
async function endOffersTaken(tx: Tx, appointment: AppointmentFacts, now: Date): Promise<void> {
  await invalidateOpenOffers(
    tx,
    and(
      eq(waitlistOffer.professionalId, appointment.professionalId),
      lt(waitlistOffer.startsAt, appointment.endsAt),
      gt(waitlistOffer.endsAt, appointment.startsAt),
    ),
    { reason: 'slot_taken', now },
  );
}

export interface SlotTrigger {
  handle(tx: Tx, event: AppointmentEvent): Promise<void>;
}

/**
 * What the waitlist does when scheduling tells it something happened (waitlist, "Matching freed
 * slots"). It runs inside the transaction of the booking, the move or the cancellation:
 *
 * - A slot came free (a cancellation, a move away, a block removed): the match is queued. A hold
 *   that ran out never gets here, because scheduling does not publish it.
 * - Somebody takes time (a booking, a move into it, a cancelled appointment brought back): the
 *   open offers for that time end at once, so the patient is not told a taken slot is theirs.
 */
export function createSlotTrigger(deps: {
  jobs: JobClient | undefined;
  clock: () => Date;
}): SlotTrigger {
  return {
    async handle(tx, event) {
      switch (event.kind) {
        case 'slot_freed':
          if (deps.jobs) {
            await enqueueMatch(
              tx,
              deps.jobs,
              {
                professionalId: event.slot.professionalId,
                locationId: event.slot.locationId,
                startsAt: event.slot.startsAt,
                endsAt: event.slot.endsAt,
              },
              event.cause,
            );
          }
          return;
        case 'created':
        case 'rescheduled':
        case 'reassigned':
          await endOffersTaken(tx, event.appointment, deps.clock());
          return;
        case 'status_changed':
          if (event.fromStatus === 'cancelled' && event.appointment.status !== 'cancelled') {
            await endOffersTaken(tx, event.appointment, deps.clock());
          }
          return;
        default:
          return;
      }
    },
  };
}

import { eq } from 'drizzle-orm';

import { tenant } from '../../../db/schema/tenant.js';
import { waitlistEntry, waitlistOffer } from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import type { SchedulingPorts } from '../../scheduling/index.js';

import { recordCall } from './calls.js';
import { expireOffer } from './expiry.js';
import { lockOffer } from './offer-lock.js';
import { invalidateOpenOffers } from './offer-state.js';
import { SYSTEM_ACTOR, WAITLIST_OFFER_JOB } from './offers.js';
import type { DeliverWaitlistOffer } from './ports.js';
import { canBookSlot } from './slot-booking.js';
import { enqueueRematch } from './trigger.js';

/** The path the token router answers (`platform/public/token-router.ts`). */
const TOKEN_PATH = '/public/t/';

/**
 * How long after an offer closes its link still opens the page, which then says the offer is over
 * (waitlist, "Acceptance after expiry"). An expired link that answered "this link is not valid"
 * would not tell the patient they are still on the list.
 */
const LINK_GRACE_MS = 12 * 3_600_000;

export interface DeliveryDeps {
  portsOf(tx: Tx): SchedulingPorts;
  jobs: JobClient;
  tokens: ActionTokens;
  origins: PublicOrigins;
  deliver: DeliverWaitlistOffer;
}

export type DeliveryOutcome = 'delivered' | 'skipped' | 'ended' | 'undeliverable';

/**
 * Sends one offer (the `waitlist.offer` job). The offer has to be open and not delivered yet, and
 * its slot has to be one a booking could still take: a slot that went away in the meantime ends
 * the offer instead. The patient gets a single-use link to the page of the offer, and the delivery
 * (the notifications module) chooses the channel the patient allows. If no channel is left the
 * entry becomes manual contact only, reception is shown the slot, and the next entry is offered
 * it. A failure of the delivery rolls the whole job back, and the retry sends it.
 */
export async function deliverOffer(
  tx: Tx,
  deps: DeliveryDeps,
  input: { offerId: string; now: Date },
): Promise<DeliveryOutcome> {
  const { now } = input;
  const ports = deps.portsOf(tx);
  const offer = await lockOffer(tx, ports, input.offerId);
  if (offer?.status !== 'open' || offer.deliveredAt !== null) return 'skipped';
  if (offer.expiresAt.getTime() <= now.getTime()) {
    await expireOffer(tx, deps, { offerId: offer.id, now });
    return 'ended';
  }
  if (offer.sendAt.getTime() > now.getTime()) {
    // Early (a deferral for quiet hours): come back when the offer is due.
    await deps.jobs.enqueue(
      tx,
      WAITLIST_OFFER_JOB,
      { tenantId: offer.tenantId, offerId: offer.id },
      { startAfter: offer.sendAt },
    );
    return 'skipped';
  }

  const booking = await canBookSlot(ports, {
    patientId: offer.patientId,
    professionalId: offer.professionalId,
    locationId: offer.locationId,
    appointmentTypeId: offer.appointmentTypeId,
    startsAt: offer.startsAt,
    identityConfirmed: true,
    auditActor: SYSTEM_ACTOR,
    now,
  });
  if (!booking.ok) {
    // The slot went to somebody else or stopped being bookable: nobody else can have it either.
    await invalidateOpenOffers(tx, eq(waitlistOffer.id, offer.id), { reason: booking.reason, now });
    return 'ended';
  }

  const [organization] = await tx.select({ slug: tenant.slug }).from(tenant);
  if (!organization) throw new Error('the organization of the offer does not exist');
  const issued = await deps.tokens.issue(tx, {
    kind: 'waitlist_offer',
    subjectId: offer.id,
    payload: { entryId: offer.entryId },
    ttlMs: offer.expiresAt.getTime() - now.getTime() + LINK_GRACE_MS,
  });
  const delivered = await deps.deliver(tx, {
    offerId: offer.id,
    patientId: offer.patientId,
    professionalId: offer.professionalId,
    locationId: offer.locationId,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    expiresAt: offer.expiresAt,
    offerTokenUrl: `${deps.origins(organization.slug)}${TOKEN_PATH}${issued.token}`,
  });

  if (delivered.channel === 'none') {
    await deps.tokens.revokeForSubject(tx, 'waitlist_offer', offer.id);
    await invalidateOpenOffers(tx, eq(waitlistOffer.id, offer.id), {
      reason: 'undeliverable',
      now,
    });
    await tx
      .update(waitlistEntry)
      .set({ manualContactOnly: true, manualReason: 'undeliverable' })
      .where(eq(waitlistEntry.id, offer.entryId));
    await recordCall(
      tx,
      ports,
      {
        entryId: offer.entryId,
        professionalId: offer.professionalId,
        locationId: offer.locationId,
        appointmentTypeId: offer.appointmentTypeId,
        startsAt: offer.startsAt,
        endsAt: offer.endsAt,
      },
      'undeliverable',
    );
    await enqueueRematch(tx, deps.jobs, [offer]);
    return 'undeliverable';
  }

  await tx
    .update(waitlistOffer)
    .set({ channel: delivered.channel, deliveredAt: now, messageId: delivered.messageId })
    .where(eq(waitlistOffer.id, offer.id));
  return 'delivered';
}

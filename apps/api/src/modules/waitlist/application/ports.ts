import type { WaitlistChannel } from '@consultorio/contracts';

import type { Tx } from '../../../platform/db/tenant-context.js';

/** What the waitlist hands to the delivery of an offer. Administrative facts and one link. */
export interface WaitlistOfferDelivery {
  offerId: string;
  patientId: string;
  professionalId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  expiresAt: Date;
  /** The single-use link that opens the accept and decline page of the offer. */
  offerTokenUrl: string;
}

export interface WaitlistOfferDelivered {
  /** The channel the message was handed to, or `none` when the patient cannot be reached. */
  channel: WaitlistChannel | 'none';
  messageId: string | null;
}

/**
 * Sends an offer to the patient over the channel the patient allows (waitlist, "Opt-out and consent
 * in offers"): WhatsApp only with its opt-in, email unless the patient opted out, never both, and
 * `none` when no channel is left. Runs inside the transaction of the `waitlist.offer` job.
 *
 * This is the port to the notifications module. The module's own `deliverWaitlistOffer` is the
 * implementation; `main/wiring/waitlist.ts` is the one place that connects them.
 */
export type DeliverWaitlistOffer = (
  tx: Tx,
  input: WaitlistOfferDelivery,
) => Promise<WaitlistOfferDelivered>;

/**
 * When the quiet hours that cover `at` in the location's zone end, or `null` outside them. The
 * notifications module sends nothing during quiet hours (offers are not exempt) and answers
 * `channel: 'none'` for it, so the waitlist asks first and puts the offer off to the end of them: a
 * `none` that comes from quiet hours is not a failed delivery. Optional in the jobs (without it the
 * waitlist relies on its own deferral when it makes the offer).
 */
export type OfferQuietHoursEnd = (
  tx: Tx,
  input: { locationId: string; at: Date },
) => Promise<Date | null>;

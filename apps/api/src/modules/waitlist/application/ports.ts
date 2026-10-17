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
 * implementation; `main/wiring/waitlist.ts` is the one place that connects them. Until it is
 * connected the wiring uses a plain email stand-in (`createEmailOfferDelivery`).
 */
export type DeliverWaitlistOffer = (
  tx: Tx,
  input: WaitlistOfferDelivery,
) => Promise<WaitlistOfferDelivered>;

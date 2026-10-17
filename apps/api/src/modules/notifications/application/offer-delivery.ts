import { eq } from 'drizzle-orm';

import { messageOffer } from '../../../db/schema/notifications.js';
import { location } from '../../../db/schema/tenant.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { selectChannels } from '../domain/channel-policy.js';
import { isInQuietHours, quietHoursEnd } from '../domain/quiet-hours.js';

import { loadTenantState } from './context.js';
import type { TenantRef } from './deps.js';
import { dedupeKeyFor, queueMessage } from './queue.js';
import { loadRecipient } from './recipients.js';
import { loadMessagingSettings } from './settings.js';
import { UNLIMITED_QUOTA, whatsappQuotaAvailable, type QuotaPolicy } from './usage.js';

/**
 * The delivery entry point of the waitlist (spec "Opt-out and consent in offers"). The waitlist
 * module decides WHO is offered a slot and builds the single-use link; this module decides HOW the
 * offer reaches the patient and whether it may now:
 *
 * - the channel is the first one the patient allows (WhatsApp with an opt-in, otherwise email), with
 *   the same policy as reminders: opt-outs, unreachable contacts, the organization's WhatsApp
 *   switch and the professional's quota;
 * - nothing is sent during quiet hours, while the organization is read-only, to a demonstration
 *   organization, or for an offer that already expired: the answer is `none` and nothing is queued
 *   (the waitlist decides whether to wait for the end of quiet hours, see `offerQuietHoursEnd`, or
 *   to leave the slot to reception);
 * - the message is queued in the caller's transaction and sent by the worker, so a rolled back
 *   offer sends nothing and a crash never sends twice. The link is kept apart from the message log
 *   (`message_offer`), where the sending job reads it.
 */

export interface WaitlistOfferInput {
  offerId: string;
  patientId: string;
  /** The professional of the slot: the WhatsApp quota is counted against them. */
  professionalId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  /** After this moment the offer is closed and the message is not sent. */
  expiresAt: Date;
  /** The single-use address that accepts or declines the offer. */
  offerTokenUrl: string;
}

export interface WaitlistOfferDelivery {
  /** The channel the offer was queued on; `none` when it was not sent. */
  channel: 'whatsapp' | 'email' | 'none';
  /** The logged message; null when nothing was queued. */
  messageId: string | null;
}

const NOT_SENT: WaitlistOfferDelivery = { channel: 'none', messageId: null };

/** What delivering an offer needs from the process: the queue, the clock and the providers. */
export interface OfferDeliveryDeps {
  jobs: JobClient;
  clock: () => Date;
  /** False when no WhatsApp provider serves the organization. */
  whatsappAvailable(tenant: TenantRef): boolean;
  quota?: QuotaPolicy | undefined;
}

/**
 * The waitlist calls a plain function, from the API (a slot freed by a request) and from the
 * worker (an offer that expired passes to the next patient), so the process binds its dependencies
 * once, when it builds the notifications module. A process that never bound them (no queue) answers
 * "none" to every offer.
 */
let bound: OfferDeliveryDeps | undefined;

export function bindOfferDelivery(deps: OfferDeliveryDeps | undefined): void {
  bound = deps;
}

/** What the process bound: the queue, the clock and the providers. Undefined without a queue. */
export function boundDelivery(): OfferDeliveryDeps | undefined {
  return bound;
}

async function timeZoneOf(tx: Tx, locationId: string): Promise<string | null> {
  const [row] = await tx
    .select({ timeZone: location.timeZone })
    .from(location)
    .where(eq(location.id, locationId));
  return row?.timeZone ?? null;
}

/**
 * When quiet hours end at a location, if `at` is inside them; null when it is not (or there are
 * no quiet hours). The waitlist uses it to decide whether an offer can wait for the morning.
 */
export async function offerQuietHoursEnd(
  tx: Tx,
  input: { locationId: string; at: Date },
): Promise<Date | null> {
  const zone = await timeZoneOf(tx, input.locationId);
  if (zone === null) return null;
  const settings = await loadMessagingSettings(tx);
  return quietHoursEnd(input.at, zone, settings.quietHours);
}

export async function deliverWaitlistOffer(
  tx: Tx,
  input: WaitlistOfferInput,
): Promise<WaitlistOfferDelivery> {
  const deps = bound;
  if (!deps) return NOT_SENT;
  const now = deps.clock();
  if (input.expiresAt.getTime() <= now.getTime()) return NOT_SENT;

  const state = await loadTenantState(tx, await currentTenantId(tx));
  // A read-only organization sends nothing, and a demonstration one never reaches a patient.
  if (!state || state.status !== 'active' || state.isDemo) return NOT_SENT;
  const tenant: TenantRef = { id: state.id, isDemo: false };

  const zone = await timeZoneOf(tx, input.locationId);
  const settings = await loadMessagingSettings(tx);
  if (zone === null || isInQuietHours(now, zone, settings.quietHours)) return NOT_SENT;

  const recipient = await loadRecipient(tx, input.patientId);
  if (!recipient) return NOT_SENT;
  const decision = selectChannels('waitlist_offer', recipient.facts, {
    whatsappEnabled: settings.whatsappEnabled && deps.whatsappAvailable(tenant),
    whatsappQuotaAvailable: await whatsappQuotaAvailable(
      deps.quota ?? UNLIMITED_QUOTA,
      tx,
      input.professionalId,
      now,
    ),
  });
  const channel = decision.channels[0];
  if (channel === undefined) return NOT_SENT;

  // One offer, one message per channel: asking twice returns the first message.
  const group = `waitlist_offer:${input.offerId}`;
  const queued = await queueMessage(deps, tx, {
    kind: 'waitlist_offer',
    channel,
    patientId: input.patientId,
    appointmentId: null,
    professionalId: input.professionalId,
    plannedStartsAt: input.startsAt,
    appointmentVersion: null,
    sendAt: now,
    dedupeKey: dedupeKeyFor(group, channel),
  });
  if (queued.created) {
    await tx.insert(messageOffer).values({
      tenantId: state.id,
      messageId: queued.id,
      offerId: input.offerId,
      locationId: input.locationId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      expiresAt: input.expiresAt,
      url: input.offerTokenUrl,
    });
  }
  return { channel, messageId: queued.id };
}

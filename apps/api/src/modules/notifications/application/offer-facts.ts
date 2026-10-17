import { eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { messageOffer } from '../../../db/schema/notifications.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * Where and with whom a waitlist offer is: the name and time zone of the location, and the name of
 * the professional (null when the member has no display name, or the message has no professional).
 */
export async function loadOfferPlace(
  tx: Tx,
  locationId: string,
  professionalId: string | null,
): Promise<{ locationName: string; timeZone: string; professionalName: string | null }> {
  const [place] = await tx
    .select({ locationName: location.name, timeZone: location.timeZone })
    .from(location)
    .where(eq(location.id, locationId));
  if (!place) throw new Error('The location of the offer does not exist');
  let professionalName: string | null = null;
  if (professionalId !== null) {
    const [named] = await tx
      .select({ name: membership.displayName })
      .from(professional)
      .innerJoin(membership, eq(membership.id, professional.membershipId))
      .where(eq(professional.id, professionalId));
    professionalName = named?.name ?? null;
  }
  return { ...place, professionalName };
}

/**
 * Gives the message of another channel the slot and the link of an offer: when the first channel
 * fails for good, the offer goes by the next one with the same link.
 */
export async function copyOffer(tx: Tx, fromMessageId: string, toMessageId: string): Promise<void> {
  const [offer] = await tx
    .select()
    .from(messageOffer)
    .where(eq(messageOffer.messageId, fromMessageId));
  if (!offer) return;
  await tx.insert(messageOffer).values({
    tenantId: offer.tenantId,
    messageId: toMessageId,
    offerId: offer.offerId,
    locationId: offer.locationId,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    expiresAt: offer.expiresAt,
    url: offer.url,
  });
}

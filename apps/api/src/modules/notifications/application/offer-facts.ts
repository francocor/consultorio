import { eq } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { messageOffer, type MessageOfferRow } from '../../../db/schema/notifications.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { uuidv7 } from '../../../platform/db/uuid.js';

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

const OFFER_URL_FIELD = { table: 'message_offer', column: 'url_enc' } as const;

/** Encrypts the address of an offer for the `message_offer` row `rowId`. */
export function sealOfferUrl(
  tx: Tx,
  keys: TenantKeys,
  rowId: string,
  url: string,
): Promise<Buffer> {
  return keys.encryptField(tx, { ...OFFER_URL_FIELD, rowId }, url);
}

/** The address of an offer in plain text, or null once it was cleared. A legacy row is read as it is. */
export async function readOfferUrl(
  tx: Tx,
  keys: TenantKeys,
  offer: Pick<MessageOfferRow, 'id' | 'url' | 'urlEnc'>,
): Promise<string | null> {
  if (offer.urlEnc == null) return offer.url;
  const plain = await keys.decryptField(tx, { ...OFFER_URL_FIELD, rowId: offer.id }, offer.urlEnc);
  return plain.toString('utf8');
}

/**
 * Gives the message of another channel the slot and the link of an offer: when the first channel
 * fails for good, the offer goes by the next one with the same link.
 */
export async function copyOffer(
  tx: Tx,
  keys: TenantKeys,
  fromMessageId: string,
  toMessageId: string,
): Promise<void> {
  const [offer] = await tx
    .select()
    .from(messageOffer)
    .where(eq(messageOffer.messageId, fromMessageId));
  if (!offer) return;
  const url = await readOfferUrl(tx, keys, offer);
  // The ciphertext is bound to the row it lives in: the copy has an id of its own.
  const id = uuidv7();
  await tx.insert(messageOffer).values({
    id,
    tenantId: offer.tenantId,
    messageId: toMessageId,
    offerId: offer.offerId,
    locationId: offer.locationId,
    startsAt: offer.startsAt,
    endsAt: offer.endsAt,
    expiresAt: offer.expiresAt,
    urlEnc: url === null ? null : await sealOfferUrl(tx, keys, id, url),
  });
}

import type { MessageChannel } from '@consultorio/contracts';
import { and, asc, eq, isNotNull, notLike } from 'drizzle-orm';

import { message } from '../../../db/schema/notifications.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readPatientContact } from '../../patients/index.js';
import { hashAddress, legacyAddressHash } from '../domain/address.js';
import { normalizeWhatsAppNumber } from '../domain/phone.js';

/** Rows looked at per run: the sweep comes back every hour, so a large log is done in a few days. */
const BATCH = 200;

/**
 * Replaces the unsalted address hashes the message log held before the platform pepper (judgment
 * day finding C11). The address itself is not kept, so a row is recognized by the patient's
 * CURRENT address: when its unsalted hash is the one stored, the row gets the keyed hash. A row
 * whose address has changed since can no longer be recognized and could never match a reply or a
 * "failed for good" check again, so its hash is dropped: nothing is lost that was still usable.
 */
export async function rehashLegacyAddresses(tx: Tx): Promise<number> {
  const rows = await tx
    .select({
      id: message.id,
      patientId: message.patientId,
      channel: message.channel,
      addressHash: message.addressHash,
    })
    .from(message)
    .where(and(isNotNull(message.addressHash), notLike(message.addressHash, 'h2:%')))
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(BATCH);

  const contacts = new Map<string, Awaited<ReturnType<typeof readPatientContact>>>();
  for (const row of rows) {
    if (!contacts.has(row.patientId)) {
      contacts.set(row.patientId, await readPatientContact(tx, row.patientId));
    }
    const contact = contacts.get(row.patientId);
    const channel = row.channel as MessageChannel;
    const current =
      channel === 'email'
        ? contact?.email?.trim() || null
        : contact?.phone
          ? normalizeWhatsAppNumber(contact.phone)
          : null;
    const next =
      current !== null && legacyAddressHash(channel, current) === row.addressHash
        ? hashAddress(channel, current)
        : null;
    await tx.update(message).set({ addressHash: next }).where(eq(message.id, row.id));
  }
  return rows.length;
}

import { and, eq, inArray } from 'drizzle-orm';

import { message } from '../../../db/schema/notifications.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { readPatientContact } from '../../patients/index.js';
import { hashAddress } from '../domain/address.js';
import type { ChannelFacts } from '../domain/channel-policy.js';
import { normalizeWhatsAppNumber } from '../domain/phone.js';

/** Failure reasons that say the address itself is bad, as opposed to a problem of the moment. */
const CONTACT_FAILURES = ['not_on_whatsapp', 'invalid_number', 'mailbox_unavailable'] as const;

/** A patient as messaging sees them: how to reach them and what they allowed. */
export interface Recipient {
  patientId: string;
  givenNames: string;
  /** Lower-case, as typed by reception; null when there is none. */
  email: string | null;
  /** E.164, or null when there is none or it cannot be read as a mobile number. */
  phone: string | null;
  facts: ChannelFacts;
}

/** The raw, trimmed email of a patient, or null when empty. */
function cleanEmail(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

/** Channels whose current address already failed for good. A corrected address is a new one. */
async function unreachableChannels(
  tx: Tx,
  patientId: string,
  addresses: { email: string | null; phone: string | null },
): Promise<{ email: boolean; whatsapp: boolean }> {
  const hashes = [
    ...(addresses.email === null ? [] : [hashAddress('email', addresses.email)]),
    ...(addresses.phone === null ? [] : [hashAddress('whatsapp', addresses.phone)]),
  ];
  if (hashes.length === 0) return { email: false, whatsapp: false };
  const rows = await tx
    .selectDistinct({ channel: message.channel, addressHash: message.addressHash })
    .from(message)
    .where(
      and(
        eq(message.patientId, patientId),
        eq(message.status, 'failed'),
        inArray(message.failureReason, [...CONTACT_FAILURES]),
        inArray(message.addressHash, hashes),
      ),
    );
  return {
    email: rows.some((row) => row.channel === 'email'),
    whatsapp: rows.some((row) => row.channel === 'whatsapp'),
  };
}

/**
 * Loads a patient for a message. The channel preferences of the patient (opt-in and opt-out) are
 * joined here too, in the slice that records them.
 */
export async function loadRecipient(tx: Tx, patientId: string): Promise<Recipient | null> {
  const contact = await readPatientContact(tx, patientId);
  if (!contact) return null;
  const email = cleanEmail(contact.email);
  const phone = contact.phone === null ? null : normalizeWhatsAppNumber(contact.phone);
  const unreachable = await unreachableChannels(tx, patientId, { email, phone });
  return {
    patientId,
    givenNames: contact.givenNames,
    email,
    phone,
    facts: {
      email,
      phone,
      emailPreference: 'default',
      whatsappPreference: 'none',
      emailUnreachable: unreachable.email,
      whatsappUnreachable: unreachable.whatsapp,
    },
  };
}

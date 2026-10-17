import { sql } from 'drizzle-orm';

import type { Tx } from '../../../platform/db/tenant-context.js';
import { readPatientContact } from '../../patients/index.js';
import type { Reach } from '../domain/manual-contact.js';

type State = 'opted_in' | 'opted_out';

/**
 * The latest thing a patient said about each channel (messaging keeps it as a history in
 * `channel_preference`). Read only: the waitlist never records a preference.
 */
async function channelStates(tx: Tx, patientId: string): Promise<Map<string, State>> {
  const result = await tx.execute<{ channel: string; state: string }>(
    sql`SELECT DISTINCT ON (channel) channel, state
          FROM channel_preference
         WHERE patient_id = ${patientId}
         ORDER BY channel, created_at DESC, id DESC`,
  );
  const states = new Map<string, State>();
  for (const row of result.rows) {
    if (row.state === 'opted_in' || row.state === 'opted_out') states.set(row.channel, row.state);
  }
  return states;
}

/**
 * Which channels can carry a waitlist offer to this patient (waitlist, "Opt-out and consent in
 * offers"). Email needs an address and no opt-out. WhatsApp needs a number and a recorded opt-in
 * to WhatsApp, which only messaging records: a patient who never opted in is not reachable on it.
 * A patient that does not exist is reachable on nothing.
 */
export async function reachOf(tx: Tx, patientId: string): Promise<Reach> {
  const contact = await readPatientContact(tx, patientId);
  const states = await channelStates(tx, patientId);
  const hasEmail = Boolean(contact?.email?.trim());
  const hasPhone = Boolean(contact?.phone?.trim());
  return {
    email: {
      usable: hasEmail && states.get('email') !== 'opted_out',
      optedOut: states.get('email') === 'opted_out',
    },
    whatsapp: {
      usable: hasPhone && states.get('whatsapp') === 'opted_in',
      optedOut: states.get('whatsapp') === 'opted_out',
    },
  };
}

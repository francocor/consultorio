import type { EmailOnlyMessageKind, MessageChannel } from '@consultorio/contracts';

import type { Tx } from '../../../platform/db/tenant-context.js';
import { selectChannels, type ChannelDecision } from '../domain/channel-policy.js';

import { loadRecipient } from './recipients.js';

/** How another module reaches a patient with a notice that is not about an appointment. */
export interface NoticeRecipient {
  patientId: string;
  givenNames: string;
  /** The address the notice goes to, when the policy lets email carry it. */
  email: string | null;
  /** The channels the policy allows, in order. Never WhatsApp: only appointment messages use it. */
  channels: MessageChannel[];
  /** Why a channel was left out, for the record of a notice that was not sent. */
  skipped: ChannelDecision['skipped'];
}

/**
 * Who a notice of a kind that is not about an appointment (an invoice, a code, an account notice)
 * can reach, and how: the channel policy of notifications decides (spec "Channels and purposes").
 * Those kinds are email only, whatever the patient opted in to; an opt-out of email, a missing
 * address or an address that failed for good leaves no channel. Null when the patient does not exist
 * in the organization.
 */
export async function loadNoticeRecipient(
  tx: Tx,
  patientId: string,
  kind: EmailOnlyMessageKind,
): Promise<NoticeRecipient | null> {
  const recipient = await loadRecipient(tx, patientId);
  if (!recipient) return null;
  const decision = selectChannels(kind, recipient.facts, {
    whatsappEnabled: false,
    whatsappQuotaAvailable: false,
  });
  return {
    patientId,
    givenNames: recipient.givenNames,
    email: decision.channels.includes('email') ? recipient.email : null,
    channels: decision.channels,
    skipped: decision.skipped,
  };
}

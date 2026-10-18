import { asc } from 'drizzle-orm';

import { channelPreference } from '../../../db/schema/channel-preference.js';
import { message } from '../../../db/schema/notifications.js';
import { whatsappUsageEvent } from '../../../db/schema/usage-event.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by notifications (reminders, confirmations and offers over email
 * and WhatsApp): the choices of every patient on a channel (the whole history, with who recorded
 * each one), the log of the messages that were sent and the WhatsApp that was counted. It carries
 * metadata only. The text of a message is never stored; the log keeps a hash of an address, which is
 * left out, and the addresses of links (offers) and the tokens are left out too.
 */
export const exportNotifications: ExportContributor = async ({ tx }) => {
  const preferences = await tx
    .select({
      id: channelPreference.id,
      patientId: channelPreference.patientId,
      channel: channelPreference.channel,
      state: channelPreference.state,
      source: channelPreference.source,
      recordedBy: channelPreference.recordedBy,
      createdAt: channelPreference.createdAt,
    })
    .from(channelPreference)
    .orderBy(asc(channelPreference.createdAt), asc(channelPreference.id));
  const messages = await tx
    .select({
      id: message.id,
      patientId: message.patientId,
      appointmentId: message.appointmentId,
      professionalId: message.professionalId,
      kind: message.kind,
      channel: message.channel,
      status: message.status,
      cancelReason: message.cancelReason,
      failureReason: message.failureReason,
      attempts: message.attempts,
      trigger: message.trigger,
      sendAt: message.sendAt,
      sentAt: message.sentAt,
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
      createdAt: message.createdAt,
    })
    .from(message)
    .orderBy(asc(message.createdAt), asc(message.id));
  const whatsappUsage = await tx
    .select({
      messageId: whatsappUsageEvent.messageId,
      professionalId: whatsappUsageEvent.professionalId,
      period: whatsappUsageEvent.period,
      countedAt: whatsappUsageEvent.countedAt,
      confirmedAt: whatsappUsageEvent.confirmedAt,
      releasedAt: whatsappUsageEvent.releasedAt,
    })
    .from(whatsappUsageEvent)
    .orderBy(asc(whatsappUsageEvent.countedAt), asc(whatsappUsageEvent.id));
  return { channelPreferences: preferences, messages, whatsappUsage };
};

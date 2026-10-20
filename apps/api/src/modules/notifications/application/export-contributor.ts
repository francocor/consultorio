import { asc } from 'drizzle-orm';

import { channelPreference } from '../../../db/schema/channel-preference.js';
import { message } from '../../../db/schema/notifications.js';
import { whatsappUsageEvent } from '../../../db/schema/usage-event.js';
import {
  afterStamp,
  pagedByStamp,
  stampText,
  type ExportContributor,
} from '../../tenancy/index.js';

/**
 * Administrative export part owned by notifications (reminders, confirmations and offers over email
 * and WhatsApp): the choices of every patient on a channel (the whole history, with who recorded
 * each one), the log of the messages that were sent and the WhatsApp that was counted. It carries
 * metadata only. The text of a message is never stored; the log keeps a hash of an address, which is
 * left out, and the addresses of links (offers) and the tokens are left out too.
 *
 * Every section grows with the years of the organization (a message per reminder, per patient), so
 * each is read a page at a time, in the order of the log (time, then id).
 */
export const exportNotifications: ExportContributor = ({ tx, pageSize }) =>
  Promise.resolve({
    channelPreferences: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            id: channelPreference.id,
            patientId: channelPreference.patientId,
            channel: channelPreference.channel,
            state: channelPreference.state,
            source: channelPreference.source,
            recordedBy: channelPreference.recordedBy,
            createdAt: channelPreference.createdAt,
            cursorAt: stampText(channelPreference.createdAt),
            cursorId: channelPreference.id,
          })
          .from(channelPreference)
          .where(afterStamp(channelPreference.createdAt, channelPreference.id, after))
          .orderBy(asc(channelPreference.createdAt), asc(channelPreference.id))
          .limit(limit),
    }),
    messages: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
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
            cursorAt: stampText(message.createdAt),
            cursorId: message.id,
          })
          .from(message)
          .where(afterStamp(message.createdAt, message.id, after))
          .orderBy(asc(message.createdAt), asc(message.id))
          .limit(limit),
    }),
    whatsappUsage: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            messageId: whatsappUsageEvent.messageId,
            professionalId: whatsappUsageEvent.professionalId,
            period: whatsappUsageEvent.period,
            countedAt: whatsappUsageEvent.countedAt,
            confirmedAt: whatsappUsageEvent.confirmedAt,
            releasedAt: whatsappUsageEvent.releasedAt,
            cursorAt: stampText(whatsappUsageEvent.countedAt),
            cursorId: whatsappUsageEvent.id,
          })
          .from(whatsappUsageEvent)
          .where(afterStamp(whatsappUsageEvent.countedAt, whatsappUsageEvent.id, after))
          .orderBy(asc(whatsappUsageEvent.countedAt), asc(whatsappUsageEvent.id))
          .limit(limit),
    }),
  });

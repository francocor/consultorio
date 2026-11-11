import { asc } from 'drizzle-orm';

import { waitlistEntry, waitlistOffer } from '../../../db/schema/waitlist.js';
import {
  afterStamp,
  pagedByStamp,
  stampText,
  type ExportContributor,
} from '../../tenancy/index.js';

/**
 * Administrative export part owned by waitlist (waiting entries and the offers of freed slots):
 * what each patient waited for, why an entry closed, and what happened to every offer. Nothing in
 * it is a secret; the addresses of offers live in the notifications module and are not exported.
 */
export const exportWaitlist: ExportContributor = ({ tx, pageSize }) => {
  const entries = pagedByStamp({
    pageSize,
    fetch: (after, limit) =>
      tx
        .select({
          id: waitlistEntry.id,
          patientId: waitlistEntry.patientId,
          appointmentTypeId: waitlistEntry.appointmentTypeId,
          professionalId: waitlistEntry.professionalId,
          locationId: waitlistEntry.locationId,
          weekdays: waitlistEntry.weekdays,
          timeRanges: waitlistEntry.timeRanges,
          earliestDate: waitlistEntry.earliestDate,
          latestDate: waitlistEntry.latestDate,
          expiresAt: waitlistEntry.expiresAt,
          status: waitlistEntry.status,
          closeReason: waitlistEntry.closeReason,
          closedAt: waitlistEntry.closedAt,
          manualContactOnly: waitlistEntry.manualContactOnly,
          manualReason: waitlistEntry.manualReason,
          offersOptInAt: waitlistEntry.offersOptInAt,
          offersOptInSource: waitlistEntry.offersOptInSource,
          channels: waitlistEntry.channels,
          priority: waitlistEntry.priority,
          source: waitlistEntry.source,
          identityUnconfirmed: waitlistEntry.identityUnconfirmed,
          createdAt: waitlistEntry.createdAt,
          cursorAt: stampText(waitlistEntry.createdAt),
          cursorId: waitlistEntry.id,
        })
        .from(waitlistEntry)
        .where(afterStamp(waitlistEntry.createdAt, waitlistEntry.id, after))
        .orderBy(asc(waitlistEntry.createdAt), asc(waitlistEntry.id))
        .limit(limit),
  });
  const offers = pagedByStamp({
    pageSize,
    fetch: (after, limit) =>
      tx
        .select({
          id: waitlistOffer.id,
          entryId: waitlistOffer.entryId,
          patientId: waitlistOffer.patientId,
          professionalId: waitlistOffer.professionalId,
          locationId: waitlistOffer.locationId,
          appointmentTypeId: waitlistOffer.appointmentTypeId,
          startsAt: waitlistOffer.startsAt,
          endsAt: waitlistOffer.endsAt,
          status: waitlistOffer.status,
          endReason: waitlistOffer.endReason,
          sendAt: waitlistOffer.sendAt,
          expiresAt: waitlistOffer.expiresAt,
          closedAt: waitlistOffer.closedAt,
          channel: waitlistOffer.channel,
          deliveredAt: waitlistOffer.deliveredAt,
          appointmentId: waitlistOffer.appointmentId,
          createdAt: waitlistOffer.createdAt,
          cursorAt: stampText(waitlistOffer.createdAt),
          cursorId: waitlistOffer.id,
        })
        .from(waitlistOffer)
        .where(afterStamp(waitlistOffer.createdAt, waitlistOffer.id, after))
        .orderBy(asc(waitlistOffer.createdAt), asc(waitlistOffer.id))
        .limit(limit),
  });
  return Promise.resolve({ entries, offers });
};

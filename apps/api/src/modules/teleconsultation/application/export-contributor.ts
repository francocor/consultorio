import { asc } from 'drizzle-orm';

import { videoSession } from '../../../db/schema/teleconsultation.js';
import {
  afterStamp,
  omitCursor,
  pagedByStamp,
  stampText,
  type ExportContributor,
} from '../../tenancy/index.js';

/**
 * Administrative export part owned by teleconsultation (video links for virtual appointments): the
 * session of each virtual appointment, whether it had a link and where it came from, and whether
 * the patient opened it. The links themselves are secrets (a manual link can carry a passcode) and
 * the room lives in the appointment: neither is exported, only that a manual link existed.
 */
export const exportTeleconsultation: ExportContributor = ({ tx, pageSize }) =>
  Promise.resolve({
    videoSessions: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            id: videoSession.id,
            appointmentId: videoSession.appointmentId,
            status: videoSession.status,
            pendingReason: videoSession.pendingReason,
            closeReason: videoSession.closeReason,
            provider: videoSession.provider,
            hasManualLink: videoSession.manualLinkEnc,
            legacyManualLink: videoSession.manualLink,
            firstOpenedAt: videoSession.firstOpenedAt,
            lastOpenedAt: videoSession.lastOpenedAt,
            createdAt: videoSession.createdAt,
            cursorAt: stampText(videoSession.createdAt),
            cursorId: videoSession.id,
          })
          .from(videoSession)
          .where(afterStamp(videoSession.createdAt, videoSession.id, after))
          .orderBy(asc(videoSession.createdAt), asc(videoSession.id))
          .limit(limit),
      project: (raw) => {
        const { hasManualLink, legacyManualLink, ...rest } = omitCursor(raw);
        return { ...rest, manualLink: hasManualLink !== null || legacyManualLink !== null };
      },
    }),
  });

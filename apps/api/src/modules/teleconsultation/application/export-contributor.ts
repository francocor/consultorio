import { asc } from 'drizzle-orm';

import { videoSession } from '../../../db/schema/teleconsultation.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by teleconsultation (video links for virtual appointments): the
 * session of each virtual appointment, whether it had a link and where it came from, and whether
 * the patient opened it. The links themselves are secrets (a manual link can carry a passcode) and
 * the room lives in the appointment: neither is exported, only that a manual link existed.
 */
export const exportTeleconsultation: ExportContributor = async ({ tx }) => {
  const rows = await tx
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
    })
    .from(videoSession)
    .orderBy(asc(videoSession.createdAt), asc(videoSession.id));
  return {
    videoSessions: rows.map(({ hasManualLink, legacyManualLink, ...rest }) => ({
      ...rest,
      manualLink: hasManualLink !== null || legacyManualLink !== null,
    })),
  };
};

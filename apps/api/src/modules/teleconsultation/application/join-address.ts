import type { Tx } from '../../../platform/db/tenant-context.js';
import type { PublicOrigins } from '../../../platform/http/public-origin.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { joinWindowOf } from '../domain/join-window.js';

import { loadAppointmentFacts, loadSession, readVideoPolicy } from './video-state.js';

/**
 * What a reminder of an appointment carries for the video call (teleconsultation, "Link access and
 * validity"):
 *
 * - `in_person`: nothing; the appointment is not virtual.
 * - `link`: the platform join address, with the moment it stops being valid.
 * - `pending`: the appointment is virtual but its link does not exist yet (the room is being
 *   created, the provider failed, the integration is off and nobody attached a manual link). A
 *   reminder for it says the link will be sent separately, or is not sent at all.
 * - `closed`: the appointment was cancelled, ended or its window is over; there is nothing to send.
 */
export type VideoJoinAddress =
  | { kind: 'in_person' }
  | { kind: 'pending' }
  | { kind: 'closed' }
  | { kind: 'link'; url: string; expiresAt: Date };

/**
 * The notifications module asks for this when it renders the reminder of an appointment
 * (`VideoJoinUrlResolver` of design section 7). It runs in the transaction that renders the
 * message, because issuing an address writes the token.
 */
export interface VideoJoinUrlResolver {
  resolve(tx: Tx, appointmentId: string): Promise<VideoJoinAddress>;
}

/**
 * A patient who opens the address after the join window sees "the session is closed" instead of
 * "this link does not exist", so the address stays known for this long after the window. It still
 * forwards nowhere: only the window opens the call.
 */
export const LINK_KNOWN_AFTER_WINDOW_MS = 12 * 60 * 60_000;

export function createJoinUrlResolver(deps: {
  tokens: ActionTokens;
  origins: PublicOrigins;
  clock: () => Date;
}): VideoJoinUrlResolver {
  return {
    async resolve(tx, appointmentId) {
      const facts = await loadAppointmentFacts(tx, appointmentId);
      if (!facts?.virtual) return { kind: 'in_person' };
      const session = await loadSession(tx, appointmentId);
      if (session?.status === 'closed') return { kind: 'closed' };
      if (session?.status !== 'ready') return { kind: 'pending' };

      const policy = await readVideoPolicy(tx);
      const window = joinWindowOf(facts, policy.joinOpensMinutes);
      const now = deps.clock();
      if (now.getTime() > window.closesAt.getTime()) return { kind: 'closed' };

      const issued = await deps.tokens.issue(tx, {
        kind: 'video_join',
        subjectId: appointmentId,
        // The room the address was issued for: a move gives the appointment another one.
        payload: { room: facts.videoRoom },
        ttlMs: window.closesAt.getTime() + LINK_KNOWN_AFTER_WINDOW_MS - now.getTime(),
      });
      return {
        kind: 'link',
        url: `${deps.origins(policy.tenant.slug)}/public/v/${issued.token}`,
        expiresAt: issued.expiresAt,
      };
    },
  };
}

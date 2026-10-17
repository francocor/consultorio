import { eq } from 'drizzle-orm';

import { videoSession } from '../../../db/schema/teleconsultation.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { joinWindowOf, windowStateAt } from '../domain/join-window.js';

import { auditLinkEvent } from './video-audit.js';
import { providerFor, type SessionDeps } from './video-sessions.js';
import { loadAppointmentFacts, loadSession, readVideoPolicy } from './video-state.js';

/**
 * What the platform join address does when somebody opens it (teleconsultation, "Link access and
 * validity"). Everything that is not a working link is `unavailable`: an unknown token, a revoked
 * or expired one, a cancelled appointment and another organization's token are one outcome, so the
 * answer teaches nothing about which it was.
 */
export type PublicJoinOutcome =
  /** Inside the window with a link: send the patient to the call. */
  | { kind: 'redirect'; url: string }
  /** Looking only: the call can be entered now. Nothing was spent and nothing was recorded. */
  | { kind: 'ready' }
  /** Before the window: say when it opens. Nothing about the provider. */
  | { kind: 'early'; opensAt: Date; timeZone: string }
  /** After the window, or the session was closed. */
  | { kind: 'closed' }
  /** Inside the window, but the room has no link yet. */
  | { kind: 'pending' }
  | { kind: 'unavailable' };

export interface PublicJoinInput {
  /**
   * `view` (a GET) only looks: mail scanners and link previews open links, so it never spends a use
   * of the link nor says the patient opened it. `enter` (the POST of the button) does both.
   */
  mode: 'view' | 'enter';
  token: string;
  /** Who is asking, for the audit entry (address and browser; never a user). */
  actor: AuditActor;
}

export async function openPublicJoin(
  tx: Tx,
  deps: Pick<SessionDeps, 'adapters' | 'clock'> & { tokens: ActionTokens },
  input: PublicJoinInput,
): Promise<PublicJoinOutcome> {
  const unavailable: PublicJoinOutcome = { kind: 'unavailable' };
  const policy = await readVideoPolicy(tx);
  // A read-only organization looks like a disabled link, and nothing is written for it.
  if (policy.tenant.status !== 'active') return unavailable;

  const link = await deps.tokens.inspect(tx, 'video_join', input.token);
  if (!link) return unavailable;
  const facts = await loadAppointmentFacts(tx, link.subjectId);
  const session = facts ? await loadSession(tx, link.subjectId) : null;
  if (!facts || !session || !facts.virtual) return unavailable;
  // A token carries the room it was issued for: after a move it points at a room that is gone.
  const issuedRoom = typeof link.payload['room'] === 'string' ? link.payload['room'] : null;
  if (issuedRoom !== facts.videoRoom) return unavailable;
  if (session.status === 'closed') return { kind: 'closed' };

  const window = joinWindowOf(facts, policy.joinOpensMinutes);
  const now = deps.clock();
  const state = windowStateAt(window, now);
  if (state === 'early') {
    return { kind: 'early', opensAt: window.opensAt, timeZone: facts.timeZone };
  }
  if (state === 'closed') return { kind: 'closed' };

  const provider = providerFor(deps, policy);
  const target =
    session.manualLink ??
    (session.status === 'ready' && facts.videoRoom !== null && provider
      ? provider.joinUrl(facts.videoRoom)
      : null);
  if (target === null) return { kind: 'pending' };
  if (input.mode === 'view') return { kind: 'ready' };

  // The use is spent only now, when the patient really goes to the call.
  const used = await deps.tokens.redeem(tx, 'video_join', input.token);
  if (!used) return unavailable;
  await tx
    .update(videoSession)
    .set({
      firstOpenedAt: session.firstOpenedAt ?? now,
      lastOpenedAt: now,
    })
    .where(eq(videoSession.id, session.id));
  await auditLinkEvent(tx, {
    action: 'video.link.opened',
    appointmentId: facts.id,
    actor: input.actor,
    metadata: { manual: session.manualLink !== null },
  });
  return { kind: 'redirect', url: target };
}

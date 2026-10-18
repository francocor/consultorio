import {
  effectivePermissions,
  VIDEO_PENDING_REASONS,
  VIDEO_SESSION_STATUSES,
  type VideoJoinResponse,
  type VideoSessionSummary,
} from '@consultorio/contracts';

import { videoSession } from '../../../db/schema/teleconsultation.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { Actor } from '../../../platform/authz/actor.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import { joinWindowOf, noShowAllowedFrom, windowStateAt } from '../domain/join-window.js';
import { validateManualLink } from '../domain/manual-link.js';

import { auditLinkEvent } from './video-audit.js';
import { providerFor, type LinkReadyNotifier, type SessionDeps } from './video-sessions.js';
import {
  followableManualLink,
  loadAppointmentFacts,
  loadSession,
  readVideoPolicy,
  type AppointmentVideoFacts,
} from './video-state.js';
import { mayWorkOn, VideoAccessRefused } from './visibility.js';

type StaffDeps = Pick<SessionDeps, 'adapters' | 'clock'> & {
  /** Announces that the appointment now has a link (a manual one was attached). */
  onLinkReady?: LinkReadyNotifier | undefined;
};

/** The members of a closed list that a stored text is, or null. The columns are checked by the database. */
function oneOf<T extends string>(list: readonly T[], value: string | null | undefined): T | null {
  return list.find((member) => member === value) ?? null;
}

/** The appointment, if it exists in this organization and the actor works on it. */
async function visibleAppointment(
  tx: Tx,
  actor: Actor,
  appointmentId: string,
): Promise<AppointmentVideoFacts> {
  const facts = await loadAppointmentFacts(tx, appointmentId);
  if (!facts) throw new AppError('not_found');
  if (!(await mayWorkOn(tx, actor, facts))) throw new VideoAccessRefused('calendar_not_accessible');
  return facts;
}

/**
 * The video side of an appointment as one member of the staff may see it. It says whether the
 * appointment is virtual and has a link, and whether the viewer may join or attach one; it never
 * carries an address.
 */
export async function videoSummary(
  tx: Tx,
  deps: StaffDeps,
  actor: Actor,
  appointmentId: string,
): Promise<VideoSessionSummary> {
  const facts = await visibleAppointment(tx, actor, appointmentId);
  const session = await loadSession(tx, appointmentId);
  const policy = await readVideoPolicy(tx);
  if (!facts.virtual && !session) {
    return {
      virtual: false,
      status: null,
      pendingReason: null,
      hasLink: false,
      manual: false,
      patientOpenedLink: false,
      firstOpenedAt: null,
      integrationEnabled: policy.integrationEnabled,
      window: null,
      canJoin: false,
      canAttachManualLink: false,
      noShowAllowedFrom: null,
    };
  }

  const permissions = effectivePermissions(actor.roles, actor.grants);
  const window = joinWindowOf(facts, policy.joinOpensMinutes);
  // A virtual appointment that has no session yet (it predates the module) waits for a link.
  const status = oneOf(VIDEO_SESSION_STATUSES, session?.status) ?? 'link_pending';
  const hasLink = status === 'ready';
  return {
    virtual: true,
    status,
    pendingReason:
      status === 'link_pending'
        ? (oneOf(VIDEO_PENDING_REASONS, session?.pendingReason) ??
          (policy.integrationEnabled ? 'provider_unavailable' : 'integration_off'))
        : null,
    hasLink,
    manual: session?.manualLink != null,
    patientOpenedLink: session?.firstOpenedAt != null,
    firstOpenedAt: session?.firstOpenedAt?.toISOString() ?? null,
    integrationEnabled: policy.integrationEnabled,
    window: { opensAt: window.opensAt.toISOString(), closesAt: window.closesAt.toISOString() },
    canJoin:
      hasLink &&
      permissions.includes('teleconsultation.join') &&
      actor.professionalId === facts.professionalId &&
      windowStateAt(window, deps.clock()) === 'open',
    canAttachManualLink: status !== 'closed' && permissions.includes('scheduling.book'),
    noShowAllowedFrom: noShowAllowedFrom(facts.startsAt, policy.noShowAfterMinutes).toISOString(),
  };
}

/**
 * The assigned professional joins the call from the appointment (design section 7: professionals
 * join through an authenticated route). Only inside the join window, only the professional of the
 * appointment, and the join is audited without the address.
 */
export async function joinAsProfessional(
  tx: Tx,
  deps: StaffDeps,
  input: { actor: Actor; appointmentId: string; auditActor: AuditActor },
): Promise<VideoJoinResponse> {
  const facts = await visibleAppointment(tx, input.actor, input.appointmentId);
  if (input.actor.professionalId !== facts.professionalId) {
    throw new VideoAccessRefused('not_the_assigned_professional');
  }
  if (!facts.virtual) throw new AppError('video_not_virtual');
  const session = await loadSession(tx, facts.id);
  if (session?.status !== 'ready') throw new AppError('video_link_unavailable');

  const policy = await readVideoPolicy(tx);
  const window = joinWindowOf(facts, policy.joinOpensMinutes);
  if (windowStateAt(window, deps.clock()) !== 'open') throw new AppError('video_outside_window');

  const provider = providerFor(deps, policy);
  const url =
    session.manualLink !== null
      ? followableManualLink(session.manualLink, provider)
      : facts.videoRoom !== null && provider
        ? provider.joinUrl(facts.videoRoom)
        : null;
  if (url === null) throw new AppError('video_link_unavailable');

  await auditLinkEvent(tx, {
    action: 'video.link.joined',
    appointmentId: facts.id,
    actor: input.auditActor,
    metadata: { manual: session.manualLink !== null },
  });
  return { url };
}

/**
 * Attaches the address of a call made elsewhere, so a virtual appointment whose room could not be
 * created (or whose organization switched the integration off) still has a link. The address must
 * be https and on a host the platform allows. The audit entry keeps the host only: the rest of the
 * address may carry a passcode.
 */
export async function attachManualLink(
  tx: Tx,
  deps: StaffDeps,
  input: { actor: Actor; appointmentId: string; url: string; auditActor: AuditActor },
): Promise<void> {
  const facts = await visibleAppointment(tx, input.actor, input.appointmentId);
  if (!facts.virtual) throw new AppError('video_not_virtual');
  const session = await loadSession(tx, facts.id);
  if (session?.status === 'closed') throw new AppError('video_link_unavailable');

  const policy = await readVideoPolicy(tx);
  const domains = providerFor(deps, policy)?.manualLinkDomains ?? [];
  const checked = validateManualLink(input.url, domains);
  if (!checked.ok) {
    throw new AppError('validation_failed', [
      { path: 'url', i18nKey: `teleconsultation.manual_link.${checked.reason}` },
    ]);
  }

  await tx
    .insert(videoSession)
    .values({
      tenantId: policy.tenant.id,
      appointmentId: facts.id,
      status: 'ready',
      manualLink: checked.url,
    })
    .onConflictDoUpdate({
      target: [videoSession.tenantId, videoSession.appointmentId],
      set: {
        status: 'ready',
        pendingReason: null,
        closeReason: null,
        manualLink: checked.url,
        provider: null,
      },
    });
  await auditLinkEvent(tx, {
    action: 'video.link.manual_attached',
    appointmentId: facts.id,
    actor: input.auditActor,
    metadata: { host: new URL(checked.url).hostname },
  });
  await deps.onLinkReady?.(tx, facts.id);
}

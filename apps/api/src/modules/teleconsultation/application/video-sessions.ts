import type {
  AppointmentStatus,
  VideoCloseReason,
  VideoPendingReason,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { videoSession } from '../../../db/schema/teleconsultation.js';
import type { AdapterResolver } from '../../../main/adapter-resolver.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type {
  AppointmentEvent,
  AppointmentFacts,
} from '../../../platform/events/appointment-events.js';
import { AppError } from '../../../platform/http/problem.js';
import { JobPayload, type JobClient } from '../../../platform/jobs/boss.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import { noShowAllowedFrom } from '../domain/join-window.js';

import { newOpaqueRoomId, VideoProviderUnavailableError, type VideoLinkProvider } from './ports.js';
import { auditLinkEvent } from './video-audit.js';
import {
  loadAppointmentFacts,
  loadSession,
  readVideoPolicy,
  writeVideoRoom,
  type VideoPolicy,
} from './video-state.js';

export const VIDEO_LINK_CREATE_JOB = 'video.link.create';

/** The queue retries a failed job this many times (`video.link.create` in `platform/jobs/queues.ts`). */
export const VIDEO_LINK_RETRIES = 3;

export const VideoLinkJobPayload = JobPayload.extend({
  appointmentId: z.uuid(),
  /** The room this job was queued for: a job for a room that was replaced does nothing. */
  room: z.string().min(1),
});
export type VideoLinkJobPayload = z.infer<typeof VideoLinkJobPayload>;

export interface SessionDeps {
  /** Absent when no queue is configured: a room then cannot be created, and the session says so. */
  jobs?: JobClient | undefined;
  adapters?: AdapterResolver | undefined;
  tokens: ActionTokens;
  clock: () => Date;
}

/** The provider that serves this organization, or none when the deployment has none for it. */
export function providerFor(
  deps: Pick<SessionDeps, 'adapters'>,
  policy: VideoPolicy,
): VideoLinkProvider | undefined {
  return deps.adapters?.forTenant(
    { id: policy.tenant.id, isDemo: policy.tenant.isDemo },
    'videoLink',
  );
}

interface Start {
  room: string | null;
  pending: VideoPendingReason;
  enqueue: boolean;
}

/** What a new room (or a new appointment) does: ask the provider, or wait for a manual link. */
function planStart(deps: SessionDeps, policy: VideoPolicy): Start {
  if (!policy.integrationEnabled) return { room: null, pending: 'integration_off', enqueue: false };
  if (!providerFor(deps, policy) || !deps.jobs) {
    return { room: null, pending: 'provider_unavailable', enqueue: false };
  }
  return { room: newOpaqueRoomId(), pending: 'creating', enqueue: true };
}

async function queueRoom(
  tx: Tx,
  deps: SessionDeps,
  policy: VideoPolicy,
  appointmentId: string,
  start: Start,
): Promise<void> {
  if (!start.enqueue || start.room === null || !deps.jobs) return;
  await deps.jobs.enqueue(tx, VIDEO_LINK_CREATE_JOB, {
    tenantId: policy.tenant.id,
    appointmentId,
    room: start.room,
  });
}

/** A virtual appointment is born without a link; the job asks the provider for the room. */
async function openSession(
  tx: Tx,
  deps: SessionDeps,
  policy: VideoPolicy,
  appointmentId: string,
): Promise<void> {
  const start = planStart(deps, policy);
  await writeVideoRoom(tx, appointmentId, start.room);
  await tx
    .insert(videoSession)
    .values({
      tenantId: policy.tenant.id,
      appointmentId,
      status: 'link_pending',
      pendingReason: start.pending,
    })
    .onConflictDoNothing();
  await queueRoom(tx, deps, policy, appointmentId, start);
}

/**
 * The appointment moved to another time, place or professional (or to another patient record): the
 * old room and the old addresses die and a new room is asked for. The addresses the old reminders
 * carry stop working at once, and so does the manual link, which belonged to the old session.
 */
async function renewSession(
  tx: Tx,
  deps: SessionDeps,
  policy: VideoPolicy,
  appointmentId: string,
  cause: 'rescheduled' | 'reassigned' | 'patient_changed',
): Promise<void> {
  const session = await loadSession(tx, appointmentId);
  if (!session) {
    const facts = await loadAppointmentFacts(tx, appointmentId);
    if (facts?.virtual) await openSession(tx, deps, policy, appointmentId);
    return;
  }
  if (session.status === 'closed') return;

  const revoked = await deps.tokens.revokeForSubject(tx, 'video_join', appointmentId);
  const start = planStart(deps, policy);
  await writeVideoRoom(tx, appointmentId, start.room);
  await tx
    .update(videoSession)
    .set({
      status: 'link_pending',
      pendingReason: start.pending,
      closeReason: null,
      provider: null,
      manualLink: null,
      firstOpenedAt: null,
      lastOpenedAt: null,
    })
    .where(eq(videoSession.id, session.id));
  if (session.status === 'ready' || revoked > 0) {
    await auditLinkEvent(tx, {
      action: 'video.link.revoked',
      appointmentId,
      metadata: { cause },
    });
  }
  await queueRoom(tx, deps, policy, appointmentId, start);
}

/** The appointment ended or was dropped: nobody joins any more. */
export async function closeSession(
  tx: Tx,
  deps: Pick<SessionDeps, 'tokens'>,
  appointmentId: string,
  reason: VideoCloseReason,
): Promise<void> {
  const session = await loadSession(tx, appointmentId);
  if (!session || session.status === 'closed') return;

  const revoked = await deps.tokens.revokeForSubject(tx, 'video_join', appointmentId);
  await tx
    .update(videoSession)
    .set({ status: 'closed', pendingReason: null, closeReason: reason })
    .where(eq(videoSession.id, session.id));
  await writeVideoRoom(tx, appointmentId, null);
  if (session.status === 'ready' || revoked > 0) {
    await auditLinkEvent(tx, {
      action: 'video.link.revoked',
      appointmentId,
      metadata: { cause: reason },
    });
  }
}

const CLOSING_STATUS: Partial<Record<AppointmentStatus, VideoCloseReason>> = {
  no_show: 'no_show',
  attended: 'attended',
};

async function onStatusChanged(
  tx: Tx,
  deps: SessionDeps,
  appointment: AppointmentFacts,
): Promise<void> {
  const reason = CLOSING_STATUS[appointment.status];
  if (reason === undefined) return;
  const session = await loadSession(tx, appointment.appointmentId);
  if (!session) return;
  if (reason === 'no_show') {
    const policy = await readVideoPolicy(tx);
    const allowedFrom = noShowAllowedFrom(appointment.startsAt, policy.noShowAfterMinutes);
    if (deps.clock().getTime() < allowedFrom.getTime()) {
      throw new AppError('video_no_show_too_early');
    }
  }
  await closeSession(tx, deps, appointment.appointmentId, reason);
}

/**
 * Follows the appointment: the subscriber the module registers on the event bus. It runs inside
 * the transaction of the scheduling write, so it does only quick database work and queues the
 * provider call. A virtual appointment gets a session when it is created; a move gives it a new
 * room; a cancellation, a no-show and an attendance close it; and a no-show on a virtual
 * appointment waits for the configured minutes (the write is refused, and rolled back, before).
 */
export function createSessionSubscriber(deps: SessionDeps) {
  return async (tx: Tx, event: AppointmentEvent): Promise<void> => {
    switch (event.kind) {
      case 'created': {
        const facts = await loadAppointmentFacts(tx, event.appointment.appointmentId);
        if (!facts?.virtual) return;
        await openSession(tx, deps, await readVideoPolicy(tx), facts.id);
        return;
      }
      case 'rescheduled':
      case 'reassigned':
      case 'patient_changed':
        await renewSession(
          tx,
          deps,
          await readVideoPolicy(tx),
          event.appointment.appointmentId,
          event.kind,
        );
        return;
      case 'cancelled':
        await closeSession(tx, deps, event.appointment.appointmentId, 'cancelled');
        return;
      case 'status_changed':
        await onStatusChanged(tx, deps, event.appointment);
        return;
      case 'slot_freed':
        return;
    }
  };
}

/**
 * The job `video.link.create`: asks the provider for the room named when the session was opened.
 * A job whose room is no longer the appointment's (it moved again, it was cancelled) does nothing.
 * A transient failure throws, so the queue retries; after the last retry the session is left
 * pending with an alert for the people who can attach a manual link. With the integration off, or
 * with no provider, there is no provider call at all.
 */
export async function completeRoomCreation(
  tx: Tx,
  deps: Pick<SessionDeps, 'adapters'>,
  payload: VideoLinkJobPayload,
  retryCount: number,
): Promise<void> {
  const session = await loadSession(tx, payload.appointmentId);
  const facts = await loadAppointmentFacts(tx, payload.appointmentId);
  if (
    !session ||
    !facts ||
    session.status !== 'link_pending' ||
    session.pendingReason !== 'creating' ||
    facts.videoRoom !== payload.room
  ) {
    return;
  }

  const setPending = async (reason: VideoPendingReason) => {
    await tx
      .update(videoSession)
      .set({ pendingReason: reason })
      .where(eq(videoSession.id, session.id));
  };

  const policy = await readVideoPolicy(tx);
  if (!policy.integrationEnabled) return setPending('integration_off');
  const provider = providerFor(deps, policy);
  if (!provider) return setPending('provider_unavailable');

  try {
    await provider.createRoom(payload.room);
  } catch (error) {
    if (error instanceof VideoProviderUnavailableError) return setPending('provider_unavailable');
    if (retryCount < VIDEO_LINK_RETRIES) throw error;
    return setPending('provider_failed');
  }

  await tx
    .update(videoSession)
    .set({ status: 'ready', pendingReason: null, provider: provider.name })
    .where(eq(videoSession.id, session.id));
  await auditLinkEvent(tx, {
    action: 'video.link.created',
    appointmentId: payload.appointmentId,
    metadata: { provider: provider.name },
  });
}

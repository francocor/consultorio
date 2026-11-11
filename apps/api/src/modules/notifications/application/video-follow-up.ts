import { and, eq, inArray } from 'drizzle-orm';

import { message } from '../../../db/schema/notifications.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import { selectChannels } from '../domain/channel-policy.js';
import { applyQuietHours } from '../domain/quiet-hours.js';
import { cancelReasonForAppointment } from '../domain/validity.js';

import { loadAppointment, loadTenantState } from './context.js';
import type { Worklist } from './deps.js';
import type { OfferDeliveryDeps } from './offer-delivery.js';
import { dedupeKeyFor, queueMessage } from './queue.js';
import { loadRecipient } from './recipients.js';
import { loadMessagingSettings } from './settings.js';
import { UNLIMITED_QUOTA, whatsappQuotaAvailable } from './usage.js';

/**
 * The follow-up with the video link (teleconsultation, "Link access and validity"). A reminder or a
 * confirmation of a virtual appointment that went out before the link existed says "we will send
 * the link separately"; this is the message that keeps that promise. It is queued when the link
 * comes to exist (the room was created, or a person attached a manual one), in the transaction that
 * made it so:
 *
 * - only for an appointment that still stands and whose reminder went out, for its present time and
 *   patient, saying the link would follow (`message.video_pending`); a reminder that already carried the link, or no reminder yet
 *   (the first one will carry it), needs no follow-up;
 * - on the channel the patient allows, by the same policy as any message of an appointment
 *   (WhatsApp with an opt-in, otherwise email, never both);
 * - not in quiet hours: it waits for their end when that still comes before the appointment, and
 *   otherwise reception is told that the patient has not received the link;
 * - once: one follow-up per appointment and version, however many times the link is announced;
 * - the address is written when the message is sent, from the join address of that moment, so a
 *   room that was replaced in between sends nothing (see `prepareDelivery`).
 */

/** What queueing it needs from the process: the queue, the clock, the providers, the worklist. */
export interface VideoFollowUpDeps extends Omit<OfferDeliveryDeps, 'keys'> {
  /** Reception is told when the patient cannot be given the link. Absent: nobody is told. */
  worklist?: Worklist | undefined;
}

export interface VideoFollowUp {
  /** The channel the message was queued on; `none` when nothing was queued. */
  channel: 'whatsapp' | 'email' | 'none';
  messageId: string | null;
}

const NOT_QUEUED: VideoFollowUp = { channel: 'none', messageId: null };

/** A reminder counts as having promised the link once it was sent, not while it is only queued. */
const SENT_STATUSES = ['sent', 'delivered', 'read'] as const;

export async function queueVideoLinkFollowUp(
  deps: VideoFollowUpDeps,
  tx: Tx,
  appointmentId: string,
): Promise<VideoFollowUp> {
  const now = deps.clock();
  const state = await loadTenantState(tx, await currentTenantId(tx));
  // A read-only organization sends nothing, and a demonstration one never reaches a patient.
  if (!state || state.status !== 'active' || state.isDemo) return NOT_QUEUED;

  const appointment = await loadAppointment(tx, appointmentId);
  if (!appointment?.virtual) return NOT_QUEUED;
  const stale = cancelReasonForAppointment({
    now,
    message: { patientId: appointment.patientId, plannedStartsAt: appointment.startsAt },
    appointment,
  });
  if (stale !== null) return NOT_QUEUED;

  const [promised] = await tx
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.appointmentId, appointment.id),
        // For this time and this patient: an appointment that moved or changed hands has its
        // earlier messages replaced. Any other change of state (a confirmation, a check-in) bumps
        // the version of the appointment without making the reminder less true.
        eq(message.plannedStartsAt, appointment.startsAt),
        eq(message.patientId, appointment.patientId),
        eq(message.videoPending, true),
        inArray(message.status, [...SENT_STATUSES]),
      ),
    )
    .limit(1);
  if (!promised) return NOT_QUEUED;

  // One follow-up per appointment and version: a second announcement finds the first.
  const group = `video_link:${appointment.id}:${String(appointment.version)}`;
  const [already] = await tx
    .select({ id: message.id, channel: message.channel })
    .from(message)
    .where(
      inArray(message.dedupeKey, [dedupeKeyFor(group, 'whatsapp'), dedupeKeyFor(group, 'email')]),
    )
    .limit(1);
  if (already) {
    return {
      channel: already.channel === 'whatsapp' ? 'whatsapp' : 'email',
      messageId: already.id,
    };
  }

  const tenant = { id: state.id, isDemo: false };
  const recipient = await loadRecipient(tx, appointment.patientId);
  const settings = await loadMessagingSettings(tx);
  const decision = recipient
    ? selectChannels('video_link', recipient.facts, {
        whatsappEnabled: settings.whatsappEnabled && deps.whatsappAvailable(tenant),
        whatsappQuotaAvailable: await whatsappQuotaAvailable(
          deps.quota ?? UNLIMITED_QUOTA,
          tx,
          appointment.professionalId,
          now,
        ),
      })
    : undefined;
  const channel = decision?.channels[0];
  const quiet = applyQuietHours({
    due: now,
    startsAt: appointment.startsAt,
    timeZone: appointment.timeZone,
    quiet: settings.quietHours,
  });

  if (channel === undefined || quiet.kind === 'skip') {
    // The patient was promised a link and cannot be given it now: reception can still pass it on.
    await deps.worklist?.open(tx, {
      kind: 'reminder_not_sent',
      subjectType: 'appointment',
      subjectId: appointment.id,
      locationId: appointment.locationId,
    });
    return NOT_QUEUED;
  }

  const queued = await queueMessage(deps, tx, {
    kind: 'video_link',
    channel,
    patientId: appointment.patientId,
    appointmentId: appointment.id,
    professionalId: appointment.professionalId,
    plannedStartsAt: appointment.startsAt,
    appointmentVersion: appointment.version,
    sendAt: quiet.at,
    dedupeKey: dedupeKeyFor(group, channel),
  });
  return { channel, messageId: queued.id };
}

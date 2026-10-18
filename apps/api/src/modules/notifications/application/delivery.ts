import type {
  AppointmentMessageKind,
  MessageCancelReason,
  MessageChannel,
  MessageFailureReason,
  MessageKind,
} from '@consultorio/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  message,
  messageAttempt,
  messageOffer,
  type MessageRow,
} from '../../../db/schema/notifications.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readOrganizationName } from '../../tenancy/index.js';
import type { EmailLinks } from '../assets/es-AR/email.js';
import { hashAddress } from '../domain/address.js';
import {
  selectChannels,
  isAppointmentKind,
  type ChannelDecision,
  type SkipReason,
} from '../domain/channel-policy.js';
import { classifyEmailFailure, nextRetryAt } from '../domain/delivery-rules.js';
import { applyQuietHours } from '../domain/quiet-hours.js';
import { cancelReasonForAppointment } from '../domain/validity.js';

import {
  loadAppointment,
  loadTenantState,
  type AppointmentContext,
  type TenantState,
} from './context.js';
import type { MessagingDeps, TenantRef } from './deps.js';
import { issueEmailLinks, issueOfferEmailLinks } from './links.js';
import { copyOffer, loadOfferPlace, readOfferUrl } from './offer-facts.js';
import type { WhatsAppSender } from './ports.js';
import {
  dedupeKeyFor,
  groupHasChannel,
  groupKeyOf,
  queueMessage,
  REMINDER_SEND_JOB,
} from './queue.js';
import { loadRecipient, type Recipient } from './recipients.js';
import { renderMessage, type RenderedMessage } from './render.js';
import { loadMessagingSettings, type MessagingSettings } from './settings.js';
import {
  recordWhatsappUsage,
  releaseWhatsappUsage,
  reserveWhatsappUsage,
  UNLIMITED_QUOTA,
  whatsappQuotaAvailable,
} from './usage.js';
import { videoNoteOf } from './video-join.js';

/**
 * Delivery of one queued message, in three steps so that the provider is never called inside a
 * transaction that can still roll back:
 *
 * 1. `prepareDelivery` (its own transaction, committed): re-reads everything NOW (the tenant, the
 *    appointment, the patient's channels and the settings), settles the message without sending
 *    when it should not go (cancelled, no channel left, fallback queued), and otherwise records
 *    the attempt as `started` and renders the message.
 * 2. `callProvider`: hands it to the provider. It never throws.
 * 3. `completeDelivery` (the job's transaction): records the outcome, and queues the retry, the
 *    fallback channel or the reception worklist item.
 *
 * A worker that dies between 2 and 3 leaves the attempt `started`. On retry an email is NOT sent
 * again (a provider that takes an email has no idempotency key, and a second reminder is worse
 * than a late status); a WhatsApp message is sent again with the same idempotency key, which the
 * provider collapses into one.
 */

export type Prepared =
  /** Not queued any more (already sent, cancelled or failed): nothing to do. */
  | { kind: 'idle' }
  /** Settled without calling the provider. */
  | { kind: 'settled' }
  | { kind: 'send'; send: PendingSend };

export interface PendingSend {
  tenantId: string;
  messageId: string;
  dedupeKey: string;
  kind: AppointmentMessageKind;
  channel: MessageChannel;
  attemptNo: number;
  tenant: TenantRef;
  to: string;
  rendered: RenderedMessage;
  sender: EmailSender | WhatsAppSender;
  /** Null for a waitlist offer, which is not about an appointment. */
  appointmentId: string | null;
  patientId: string;
  professionalId: string | null;
  locationId: string;
  startsAt: Date;
  appointmentVersion: number | null;
  /** The message says the video link will follow: it is remembered once it is sent. */
  videoPending: boolean;
}

export type ProviderResult =
  | { status: 'accepted'; providerMessageId: string | null }
  | { status: 'retryable'; reason: string }
  | { status: 'rejected'; reason: MessageFailureReason };

/**
 * The messages whose failure to reach the patient reception is told about. The follow-up with the
 * video link is one: the patient was promised it, so a follow-up that cannot arrive before the call
 * (quiet hours, no channel, a failure) leaves a worklist item and not a silent cancellation
 * (judgment day round 2, finding B11).
 */
const WORKLIST_KINDS: ReadonlySet<MessageKind> = new Set([
  'reminder',
  'confirmation',
  'video_link',
]);

function cancelReasonOf(skip: SkipReason | undefined): MessageCancelReason {
  switch (skip) {
    case 'opted_out':
      return 'opted_out';
    case 'integration_off':
      return 'integration_off';
    case 'quota':
      return 'quota_exhausted';
    default:
      return 'no_channel';
  }
}

/** A patient's own choice (an opt-out) is never answered by trying the other channel. */
function triesOtherChannel(skip: SkipReason | undefined): boolean {
  return skip !== 'opted_out';
}

async function cancelRow(tx: Tx, row: MessageRow, reason: MessageCancelReason): Promise<void> {
  await tx
    .update(message)
    .set({ status: 'cancelled', cancelReason: reason })
    .where(and(eq(message.id, row.id), eq(message.status, 'queued')));
  // A WhatsApp message that does not go gives its place in the quota back.
  if (row.channel === 'whatsapp') await releaseWhatsappUsage(tx, row.id);
}

interface Situation {
  state: TenantState;
  tenant: TenantRef;
  appointment: AppointmentContext;
  recipient: Recipient;
  settings: MessagingSettings;
}

async function channelOptions(
  deps: MessagingDeps,
  tx: Tx,
  situation: Pick<Situation, 'tenant' | 'settings'>,
  professionalId: string | null,
  /** The message asking, when it may already hold a place of the quota (a retry). */
  ownMessageId?: string,
) {
  return {
    whatsappEnabled:
      situation.settings.whatsappEnabled && deps.channels.whatsapp(situation.tenant) !== undefined,
    // A message with no professional (an offer, a notice) is not counted against anybody's quota.
    whatsappQuotaAvailable:
      professionalId === null ||
      (await whatsappQuotaAvailable(
        deps.quota ?? UNLIMITED_QUOTA,
        tx,
        professionalId,
        deps.clock(),
        ownMessageId,
      )),
  };
}

/**
 * Nothing more can be sent for this message group: tell reception. A reminder that was skipped is
 * `reminder_not_sent`; one that was tried and failed everywhere is `reminder_not_delivered`.
 */
async function openWorklist(
  deps: MessagingDeps,
  tx: Tx,
  kind: MessageKind,
  item: {
    worklistKind: 'reminder_not_sent' | 'reminder_not_delivered';
    appointmentId: string;
    locationId: string;
  },
): Promise<void> {
  if (!WORKLIST_KINDS.has(kind)) return;
  await deps.worklist.open(tx, {
    kind: item.worklistKind,
    subjectType: 'appointment',
    subjectId: item.appointmentId,
    locationId: item.locationId,
  });
}

/** Queues the message on the next channel the policy allows and the group has not tried yet. */
async function queueFallback(
  deps: MessagingDeps,
  tx: Tx,
  row: MessageRow,
  decision: ChannelDecision,
): Promise<MessageChannel | null> {
  const group = groupKeyOf(row.dedupeKey);
  for (const channel of decision.channels) {
    if (channel === row.channel || (await groupHasChannel(tx, group, channel))) continue;
    const queued = await queueMessage(deps, tx, {
      kind: row.kind as MessageKind,
      channel,
      patientId: row.patientId,
      appointmentId: row.appointmentId,
      professionalId: row.professionalId,
      plannedStartsAt: row.plannedStartsAt,
      appointmentVersion: row.appointmentVersion,
      sendAt: deps.clock(),
      dedupeKey: dedupeKeyFor(group, channel),
      trigger: row.trigger === 'manual' ? 'manual' : 'automatic',
    });
    // The offer message is written from the slot kept with it: the fallback needs the same.
    if (queued.created && row.kind === 'waitlist_offer') {
      await copyOffer(tx, deps.keys, row.id, queued.id);
    }
    return channel;
  }
  return null;
}

/** What starting an attempt leaves: nothing more to do, or the attempt number to send under. */
type Attempt = { settled: true } | { settled: false; attemptNo: number };

/**
 * Records the attempt that is about to be made. A started attempt without an outcome means a
 * worker died after (maybe) handing the message over: an email is then marked sent and not sent
 * again; a WhatsApp message goes again under the same idempotency key.
 */
async function startAttempt(
  tx: Tx,
  row: MessageRow,
  channel: MessageChannel,
  to: string,
  now: Date,
): Promise<Attempt> {
  const [open] = await tx
    .select({ attemptNo: messageAttempt.attemptNo, id: messageAttempt.id })
    .from(messageAttempt)
    .where(and(eq(messageAttempt.messageId, row.id), eq(messageAttempt.outcome, 'started')))
    .orderBy(desc(messageAttempt.attemptNo))
    .limit(1);
  if (open && channel === 'email') {
    await tx
      .update(messageAttempt)
      .set({ outcome: 'error', reason: 'unconfirmed' })
      .where(eq(messageAttempt.id, open.id));
    await tx
      .update(message)
      .set({ status: 'sent', sentAt: now, addressHash: hashAddress(channel, to) })
      .where(and(eq(message.id, row.id), eq(message.status, 'queued')));
    return { settled: true };
  }

  const attemptNo = open?.attemptNo ?? row.attempts + 1;
  if (!open) {
    await tx.insert(messageAttempt).values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      messageId: row.id,
      attemptNo,
      outcome: 'started',
    });
    await tx
      .update(message)
      .set({ attempts: attemptNo, addressHash: hashAddress(channel, to) })
      .where(eq(message.id, row.id));
  }
  return { settled: false, attemptNo };
}

/**
 * The channel of the message cannot carry it now (opted out, switched off, no provider, no quota):
 * the message is cancelled with the reason, and the next channel the policy allows gets it, except
 * after a patient's own opt-out. With nothing left, reception is told (appointment messages only).
 */
async function settleUnavailable(
  deps: MessagingDeps,
  tx: Tx,
  row: MessageRow,
  decision: ChannelDecision,
  appointment: AppointmentContext | null,
): Promise<void> {
  const channel = row.channel as MessageChannel;
  const skip = decision.skipped.find((entry) => entry.channel === channel)?.reason;
  await cancelRow(tx, row, cancelReasonOf(skip));
  const fallback = triesOtherChannel(skip) ? await queueFallback(deps, tx, row, decision) : null;
  if (
    fallback === null &&
    appointment !== null &&
    decision.channels.every((entry) => entry === channel)
  ) {
    await openWorklist(deps, tx, row.kind as MessageKind, {
      worklistKind: 'reminder_not_sent',
      appointmentId: appointment.id,
      locationId: appointment.locationId,
    });
  }
}

/** Kinds that answer an action or carry a one-time code: quiet hours never hold them back. */
const QUIET_EXEMPT: ReadonlySet<MessageKind> = new Set(['confirmation']);

/**
 * Quiet hours are checked again when the message is about to go, not only when it was planned: a
 * retry, a fallback to the other channel, or a job that ran late after an outage must not wake a
 * patient. Inside quiet hours the message WAITS for their end (same row, a new job) when that comes
 * before `limit` (the start of the appointment, or the expiry of an offer); it is never dropped for
 * that reason alone. A message a person asked for (a manual resend) and the exempt kinds are not
 * held. Returns what happened: `send` (go on), `waiting` (deferred, nothing more to do now) or
 * `too_late` (it could not arrive in time).
 */
async function checkQuietHours(
  deps: MessagingDeps,
  tx: Tx,
  row: MessageRow,
  input: { now: Date; timeZone: string; settings: MessagingSettings; limit: Date },
): Promise<'send' | 'waiting' | 'too_late'> {
  if (QUIET_EXEMPT.has(row.kind as MessageKind) || row.trigger === 'manual') return 'send';
  const decision = applyQuietHours({
    due: input.now,
    startsAt: input.limit,
    timeZone: input.timeZone,
    quiet: input.settings.quietHours,
  });
  if (decision.kind === 'skip') return 'too_late';
  if (decision.at.getTime() <= input.now.getTime()) return 'send';
  await tx.update(message).set({ sendAt: decision.at }).where(eq(message.id, row.id));
  await deps.jobs.enqueue(
    tx,
    REMINDER_SEND_JOB,
    { tenantId: row.tenantId, messageId: row.id },
    { startAfter: decision.at },
  );
  return 'waiting';
}

/**
 * Step 1 for a waitlist offer. It has no appointment: the message is written from the slot kept
 * with it (`message_offer`), and it is not sent once the offer has expired. Everything else (the
 * patient's choices, the providers, the attempt) is as for any other message.
 */
async function prepareOfferDelivery(
  deps: MessagingDeps,
  tx: Tx,
  row: MessageRow,
  context: { tenantId: string; state: TenantState; tenant: TenantRef; now: Date },
): Promise<Prepared> {
  const { tenantId, state, tenant, now } = context;
  const channel = row.channel as MessageChannel;
  const [offer] = await tx.select().from(messageOffer).where(eq(messageOffer.messageId, row.id));
  const offerUrl = offer ? await readOfferUrl(tx, deps.keys, offer) : null;
  if (!offer || offerUrl === null || offer.expiresAt.getTime() <= now.getTime()) {
    await cancelRow(tx, row, 'offer_expired');
    return { kind: 'settled' };
  }

  const recipient = await loadRecipient(tx, row.patientId);
  const settings = await loadMessagingSettings(tx);
  if (!recipient) {
    await cancelRow(tx, row, 'no_channel');
    return { kind: 'settled' };
  }
  const quiet = await checkQuietHours(deps, tx, row, {
    now,
    timeZone: (await loadOfferPlace(tx, offer.locationId, null)).timeZone,
    settings,
    limit: offer.expiresAt,
  });
  if (quiet !== 'send') {
    // The offer cannot wait for the morning without expiring: it is over, and the waitlist moves on.
    if (quiet === 'too_late') await cancelRow(tx, row, 'offer_expired');
    return { kind: 'settled' };
  }
  const decision = selectChannels(
    'waitlist_offer',
    recipient.facts,
    await channelOptions(deps, tx, { tenant, settings }, row.professionalId),
  );
  const sender = channel === 'email' ? deps.channels.email(tenant) : deps.channels.whatsapp(tenant);
  if (!decision.channels.includes(channel) || sender === undefined) {
    await settleUnavailable(deps, tx, row, decision, null);
    return { kind: 'settled' };
  }
  const to = channel === 'email' ? recipient.email : recipient.phone;
  if (to === null) {
    await cancelRow(tx, row, 'no_channel');
    return { kind: 'settled' };
  }
  if (await quotaTakenByRace(deps, tx, row, now)) {
    await settleUnavailable(
      deps,
      tx,
      row,
      await withoutQuota(deps, tx, 'waitlist_offer', recipient, settings, tenant),
      null,
    );
    return { kind: 'settled' };
  }
  const attempt = await startAttempt(tx, row, channel, to, now);
  if (attempt.settled) return { kind: 'settled' };

  const place = await loadOfferPlace(tx, offer.locationId, row.professionalId);
  const links: EmailLinks | undefined =
    channel === 'email'
      ? await issueOfferEmailLinks(deps, tx, {
          tenantSlug: state.slug,
          patientId: row.patientId,
          offerUrl,
        })
      : { offerUrl };
  const rendered = renderMessage({
    kind: 'waitlist_offer',
    channel,
    facts: {
      organizationName: await readOrganizationName(tx),
      patientGivenNames: recipient.givenNames,
      startsAt: offer.startsAt,
      timeZone: place.timeZone,
      locationName: place.locationName,
      professionalName: place.professionalName,
      appointmentTypeName: null,
      offerExpiresAt: offer.expiresAt,
    },
    wording: {
      hideProfessional: settings.notifications.hideProfessional,
      hideAppointmentType: settings.notifications.hideAppointmentType,
    },
    links,
  });
  return {
    kind: 'send',
    send: {
      tenantId,
      messageId: row.id,
      dedupeKey: row.dedupeKey,
      kind: 'waitlist_offer',
      channel,
      attemptNo: attempt.attemptNo,
      tenant,
      to,
      rendered,
      sender,
      appointmentId: null,
      patientId: row.patientId,
      professionalId: row.professionalId,
      locationId: offer.locationId,
      // A failed send is retried only while the offer is still open.
      startsAt: offer.expiresAt,
      appointmentVersion: null,
      videoPending: false,
    },
  };
}

/**
 * Reserves the place of a WhatsApp message in its professional's quota. True when the quota ran
 * out between the check that chose WhatsApp and now (another message took the last place).
 */
async function quotaTakenByRace(
  deps: MessagingDeps,
  tx: Tx,
  row: MessageRow,
  now: Date,
): Promise<boolean> {
  if (row.channel !== 'whatsapp' || row.professionalId === null) return false;
  const reserved = await reserveWhatsappUsage(deps.quota ?? UNLIMITED_QUOTA, tx, {
    messageId: row.id,
    professionalId: row.professionalId,
    now,
  });
  return reserved === 'exhausted';
}

/** The decision the policy would have made if the quota had been spent when the channel was chosen. */
async function withoutQuota(
  deps: MessagingDeps,
  tx: Tx,
  kind: MessageKind,
  recipient: Recipient,
  settings: MessagingSettings,
  tenant: TenantRef,
): Promise<ChannelDecision> {
  const base = await channelOptions(deps, tx, { tenant, settings }, null);
  return selectChannels(kind, recipient.facts, {
    ...base,
    whatsappQuotaAvailable: false,
  });
}

const DEADLOCK = '40P01';
const PREPARE_ATTEMPTS = 3;

function isDeadlock(error: unknown): boolean {
  const own = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return own === DEADLOCK || cause === DEADLOCK;
}

/**
 * Step 1. Runs in a transaction of its own, which is committed before the provider is called. If
 * Postgres picks it as the victim of a deadlock with a change of the agenda, nothing was committed
 * and nothing was sent, so it simply runs again (judgment day round 2, finding B5).
 */
export async function prepareDelivery(
  deps: MessagingDeps,
  tenantId: string,
  messageId: string,
): Promise<Prepared> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prepareOnce(deps, tenantId, messageId);
    } catch (error) {
      if (attempt >= PREPARE_ATTEMPTS || !isDeadlock(error)) throw error;
    }
  }
}

function prepareOnce(deps: MessagingDeps, tenantId: string, messageId: string): Promise<Prepared> {
  return deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx): Promise<Prepared> => {
    const [row] = await tx.select().from(message).where(eq(message.id, messageId)).for('update');
    if (!row || row.status !== 'queued') return { kind: 'idle' };
    const now = deps.clock();
    const kind = row.kind as MessageKind;
    const channel = row.channel as MessageChannel;

    const state = await loadTenantState(tx, tenantId);
    // The tenant is checked NOW, not when the message was queued: nothing queued during a
    // read-only period is sent after recovery, and a demo organization never sends anything.
    if (!state || state.status !== 'active') {
      await cancelRow(tx, row, 'tenant_read_only');
      return { kind: 'settled' };
    }
    if (state.isDemo) {
      await cancelRow(tx, row, 'demo_tenant');
      return { kind: 'settled' };
    }
    const tenant: TenantRef = { id: state.id, isDemo: false };
    if (kind === 'waitlist_offer') {
      return prepareOfferDelivery(deps, tx, row, { tenantId, state, tenant, now });
    }

    const appointment =
      row.appointmentId !== null ? await loadAppointment(tx, row.appointmentId) : null;
    const stale = cancelReasonForAppointment({
      now,
      message: { patientId: row.patientId, plannedStartsAt: row.plannedStartsAt },
      appointment,
    });
    if (stale !== null || appointment === null || !isAppointmentKind(kind)) {
      await cancelRow(tx, row, stale ?? 'appointment_cancelled');
      return { kind: 'settled' };
    }

    const recipient = await loadRecipient(tx, row.patientId);
    const settings = await loadMessagingSettings(tx);
    if (!recipient) {
      await cancelRow(tx, row, 'no_channel');
      return { kind: 'settled' };
    }
    const quiet = await checkQuietHours(deps, tx, row, {
      now,
      timeZone: appointment.timeZone,
      settings,
      limit: appointment.startsAt,
    });
    if (quiet === 'waiting') return { kind: 'settled' };
    if (quiet === 'too_late') {
      // It cannot reach the patient before the appointment without waking them: reception is told.
      await cancelRow(tx, row, 'no_channel');
      await openWorklist(deps, tx, kind, {
        worklistKind: 'reminder_not_sent',
        appointmentId: appointment.id,
        locationId: appointment.locationId,
      });
      return { kind: 'settled' };
    }
    const situation: Situation = { state, tenant, appointment, recipient, settings };
    const decision = selectChannels(
      kind,
      recipient.facts,
      await channelOptions(deps, tx, situation, row.professionalId, row.id),
    );
    const sender =
      channel === 'email' ? deps.channels.email(tenant) : deps.channels.whatsapp(tenant);

    if (!decision.channels.includes(channel) || sender === undefined) {
      await settleUnavailable(deps, tx, row, decision, appointment);
      return { kind: 'settled' };
    }

    const to = channel === 'email' ? recipient.email : recipient.phone;
    if (to === null) {
      await cancelRow(tx, row, 'no_channel');
      return { kind: 'settled' };
    }

    // The last place of the quota is taken here, under a lock, not by the check above.
    if (await quotaTakenByRace(deps, tx, row, now)) {
      await settleUnavailable(
        deps,
        tx,
        row,
        await withoutQuota(deps, tx, kind, recipient, settings, tenant),
        appointment,
      );
      return { kind: 'settled' };
    }

    // A virtual appointment says how to get into the call, or that the link follows.
    const video = appointment.virtual
      ? videoNoteOf(
          (await deps.videoJoin?.resolve(tx, appointment.id)) ?? { kind: 'pending' as const },
        )
      : undefined;
    // The follow-up exists to carry the link: without one (the room was replaced, the call is over)
    // there is nothing to send, and a newer follow-up will be queued if a new link appears.
    if (kind === 'video_link' && video?.kind !== 'link') {
      await cancelRow(tx, row, 'video_link_unavailable');
      return { kind: 'settled' };
    }

    const attempt = await startAttempt(tx, row, channel, to, now);
    if (attempt.settled) return { kind: 'settled' };

    const organizationName = await readOrganizationName(tx);
    const links =
      channel === 'email'
        ? await issueEmailLinks(deps, tx, kind, {
            tenantSlug: state.slug,
            appointmentId: appointment.id,
            patientId: row.patientId,
            appointmentVersion: appointment.version,
            startsAt: appointment.startsAt,
          })
        : undefined;
    const rendered = renderMessage({
      kind,
      channel,
      facts: {
        organizationName,
        patientGivenNames: recipient.givenNames,
        startsAt: appointment.startsAt,
        timeZone: appointment.timeZone,
        locationName: appointment.locationName,
        professionalName: appointment.professionalName,
        appointmentTypeName: appointment.appointmentTypeName,
      },
      wording: {
        hideProfessional: settings.notifications.hideProfessional,
        hideAppointmentType: settings.notifications.hideAppointmentType,
      },
      ...(links ? { links } : {}),
      ...(video ? { video } : {}),
    });

    return {
      kind: 'send',
      send: {
        tenantId,
        messageId: row.id,
        dedupeKey: row.dedupeKey,
        kind,
        channel,
        attemptNo: attempt.attemptNo,
        tenant,
        to,
        rendered,
        sender,
        appointmentId: appointment.id,
        patientId: row.patientId,
        professionalId: row.professionalId,
        locationId: appointment.locationId,
        startsAt: appointment.startsAt,
        appointmentVersion: row.appointmentVersion,
        videoPending: video?.kind === 'pending',
      },
    };
  });
}

/** Step 2. Hands the message to the provider. Whatever goes wrong becomes a result, not a throw. */
export async function callProvider(send: PendingSend): Promise<ProviderResult> {
  const { rendered, sender } = send;
  try {
    if (rendered.channel === 'email') {
      await (sender as EmailSender).send({
        to: send.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        tenant: send.tenant,
      });
      return { status: 'accepted', providerMessageId: null };
    }
    const result = await (sender as WhatsAppSender).send({
      templateKey: rendered.templateKey,
      to: send.to,
      vars: rendered.vars,
      idempotencyKey: send.dedupeKey,
    });
    switch (result.status) {
      case 'accepted':
        return { status: 'accepted', providerMessageId: result.providerMessageId };
      case 'rejected':
        return { status: 'rejected', reason: result.reason };
      case 'retryable':
        return { status: 'retryable', reason: 'provider_down' };
    }
  } catch (error) {
    if (rendered.channel === 'email' && classifyEmailFailure(error) === 'permanent') {
      return { status: 'rejected', reason: 'mailbox_unavailable' };
    }
    return { status: 'retryable', reason: 'provider_down' };
  }
}

/**
 * A message that failed for good: the next channel the policy allows gets it, and with none left
 * reception is told ("reminder not delivered"). The failure itself is already recorded.
 */
async function continueAfterFailure(
  deps: MessagingDeps,
  tx: Tx,
  row: MessageRow,
  tenant: TenantRef,
): Promise<void> {
  const kind = row.kind as MessageKind;
  const recipient = await loadRecipient(tx, row.patientId);
  const settings = await loadMessagingSettings(tx);
  if (!recipient || !isAppointmentKind(kind)) return;
  const decision = selectChannels(
    kind,
    recipient.facts,
    await channelOptions(deps, tx, { tenant, settings }, row.professionalId),
  );
  const fallback = await queueFallback(deps, tx, row, decision);
  if (fallback !== null || row.appointmentId === null) return;
  const appointment = await loadAppointment(tx, row.appointmentId);
  if (!appointment) return;
  await openWorklist(deps, tx, kind, {
    worklistKind: 'reminder_not_delivered',
    appointmentId: appointment.id,
    locationId: appointment.locationId,
  });
}

/** The channel could not carry the message for good: record it and look for another way. */
async function failPermanently(
  deps: MessagingDeps,
  tx: Tx,
  send: PendingSend,
  reason: MessageFailureReason,
): Promise<void> {
  await tx
    .update(message)
    .set({ status: 'failed', failureReason: reason })
    .where(and(eq(message.id, send.messageId), eq(message.status, 'queued')));
  // The provider will not carry it: the place it held in the quota is free again.
  if (send.channel === 'whatsapp') await releaseWhatsappUsage(tx, send.messageId);
  const [row] = await tx.select().from(message).where(eq(message.id, send.messageId));
  if (row) await continueAfterFailure(deps, tx, row, send.tenant);
}

/**
 * The provider took the message and later reported that it could not deliver it (a status event
 * of the webhook). The message fails like one the provider refused, and the fallback follows.
 */
export async function failAcceptedMessage(
  deps: MessagingDeps,
  tx: Tx,
  messageId: string,
  reason: MessageFailureReason,
): Promise<boolean> {
  const [failed] = await tx
    .update(message)
    .set({ status: 'failed', failureReason: reason })
    .where(and(eq(message.id, messageId), inArray(message.status, ['sent', 'queued'])))
    .returning();
  if (!failed) return false;
  // The provider said it did not deliver: the place it held in the quota is free again, also when
  // it had been confirmed on acceptance.
  if (failed.channel === 'whatsapp') {
    await releaseWhatsappUsage(tx, failed.id, { includeConfirmed: true });
  }
  const state = await loadTenantState(tx, failed.tenantId);
  if (!state || state.isDemo) return true;
  await continueAfterFailure(deps, tx, failed, { id: state.id, isDemo: false });
  return true;
}

/** Step 3. Runs in the transaction of the job. */
export async function completeDelivery(
  deps: MessagingDeps,
  tx: Tx,
  send: PendingSend,
  result: ProviderResult,
): Promise<void> {
  const now = deps.clock();
  // The message row first, then its attempt: the same order as `prepareDelivery`, so two workers
  // that meet on one message wait for each other instead of deadlocking.
  await tx
    .select({ id: message.id })
    .from(message)
    .where(eq(message.id, send.messageId))
    .for('update');
  const outcome = result.status === 'accepted' ? 'accepted' : result.status;
  await tx
    .update(messageAttempt)
    .set({ outcome, reason: result.status === 'accepted' ? null : result.reason })
    .where(
      and(
        eq(messageAttempt.messageId, send.messageId),
        eq(messageAttempt.attemptNo, send.attemptNo),
      ),
    );

  switch (result.status) {
    case 'accepted':
      await tx
        .update(message)
        .set({
          status: 'sent',
          sentAt: now,
          ...(send.videoPending ? { videoPending: true } : {}),
          ...(result.providerMessageId === null
            ? {}
            : { providerMessageId: result.providerMessageId }),
        })
        .where(and(eq(message.id, send.messageId), eq(message.status, 'queued')));
      // The provider took a WhatsApp message: it counts against its professional, once.
      if (send.channel === 'whatsapp' && send.professionalId !== null) {
        await recordWhatsappUsage(
          { quota: deps.quota ?? UNLIMITED_QUOTA, channels: deps.channels },
          tx,
          {
            messageId: send.messageId,
            professionalId: send.professionalId,
            now,
            tenant: send.tenant,
          },
        );
      }
      return;
    case 'retryable': {
      const retryAt = nextRetryAt(now, send.attemptNo, send.startsAt);
      if (retryAt === null) {
        await failPermanently(deps, tx, send, 'retries_exhausted');
        return;
      }
      await deps.jobs.enqueue(
        tx,
        REMINDER_SEND_JOB,
        { tenantId: send.tenantId, messageId: send.messageId },
        { startAfter: retryAt },
      );
      return;
    }
    case 'rejected':
      await failPermanently(deps, tx, send, result.reason);
      return;
  }
}

import type {
  AppointmentMessageKind,
  MessageCancelReason,
  MessageChannel,
  MessageFailureReason,
  MessageKind,
} from '@consultorio/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { message, messageAttempt, type MessageRow } from '../../../db/schema/notifications.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { hashAddress } from '../domain/address.js';
import {
  selectChannels,
  isAppointmentKind,
  type ChannelDecision,
  type SkipReason,
} from '../domain/channel-policy.js';
import { classifyEmailFailure, nextRetryAt } from '../domain/delivery-rules.js';
import { cancelReasonForAppointment } from '../domain/validity.js';

import {
  loadAppointment,
  loadTenantState,
  type AppointmentContext,
  type TenantState,
} from './context.js';
import type { MessagingDeps, TenantRef } from './deps.js';
import { issueEmailLinks } from './links.js';
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
import { recordWhatsappUsage, UNLIMITED_QUOTA, whatsappQuotaAvailable } from './usage.js';

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
  appointmentId: string;
  patientId: string;
  professionalId: string | null;
  locationId: string;
  startsAt: Date;
  appointmentVersion: number | null;
}

export type ProviderResult =
  | { status: 'accepted'; providerMessageId: string | null }
  | { status: 'retryable'; reason: string }
  | { status: 'rejected'; reason: MessageFailureReason };

const WORKLIST_KINDS: ReadonlySet<MessageKind> = new Set(['reminder', 'confirmation']);

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
    await queueMessage(deps, tx, {
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
    return channel;
  }
  return null;
}

/** Step 1. Runs in a transaction of its own, which is committed before the provider is called. */
export function prepareDelivery(
  deps: MessagingDeps,
  tenantId: string,
  messageId: string,
): Promise<Prepared> {
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
    const situation: Situation = { state, tenant, appointment, recipient, settings };
    const decision = selectChannels(
      kind,
      recipient.facts,
      await channelOptions(deps, tx, situation, row.professionalId),
    );
    const sender =
      channel === 'email' ? deps.channels.email(tenant) : deps.channels.whatsapp(tenant);

    if (!decision.channels.includes(channel) || sender === undefined) {
      const skip = decision.skipped.find((entry) => entry.channel === channel)?.reason;
      await cancelRow(tx, row, cancelReasonOf(skip));
      const fallback = triesOtherChannel(skip)
        ? await queueFallback(deps, tx, row, decision)
        : null;
      if (fallback === null && decision.channels.every((entry) => entry === channel)) {
        await openWorklist(deps, tx, kind, {
          worklistKind: 'reminder_not_sent',
          appointmentId: appointment.id,
          locationId: appointment.locationId,
        });
      }
      return { kind: 'settled' };
    }

    const to = channel === 'email' ? recipient.email : recipient.phone;
    if (to === null) {
      await cancelRow(tx, row, 'no_channel');
      return { kind: 'settled' };
    }

    // A started attempt without an outcome: a worker died after (maybe) handing the message over.
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
      return { kind: 'settled' };
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
    });

    return {
      kind: 'send',
      send: {
        tenantId,
        messageId: row.id,
        dedupeKey: row.dedupeKey,
        kind,
        channel,
        attemptNo,
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

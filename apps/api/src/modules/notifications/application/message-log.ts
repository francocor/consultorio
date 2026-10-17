import {
  MAX_MANUAL_RESENDS,
  type AppointmentMessagesResponse,
  type MessageChannel,
  type MessageLogEntryDto,
} from '@consultorio/contracts';
import { and, asc, eq, sql } from 'drizzle-orm';

import { message } from '../../../db/schema/notifications.js';
import { worklistItem } from '../../../db/schema/worklist.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import { selectChannels } from '../domain/channel-policy.js';

import { loadAppointment, loadTenantState } from './context.js';
import type { TenantRef } from './deps.js';
import { dedupeKeyFor, queueMessage } from './queue.js';
import { loadRecipient } from './recipients.js';
import { loadMessagingSettings } from './settings.js';
import { UNLIMITED_QUOTA, whatsappQuotaAvailable, type QuotaPolicy } from './usage.js';

/**
 * The message log of an appointment and the manual resend (spec "Audit and access to notification
 * data"). The log is metadata only: kind, channel, status, times and a reason code. A resend is a
 * reminder sent on purpose; it respects the opt-out of the patient, the policy of the channel and
 * the limit of three per appointment.
 */

const iso = (value: Date | null) => value?.toISOString() ?? null;

function toDto(row: typeof message.$inferSelect): MessageLogEntryDto {
  return {
    id: row.id,
    kind: row.kind as MessageLogEntryDto['kind'],
    channel: row.channel as MessageLogEntryDto['channel'],
    status: row.status as MessageLogEntryDto['status'],
    trigger: row.trigger === 'manual' ? 'manual' : 'automatic',
    cancelReason: row.cancelReason as MessageLogEntryDto['cancelReason'],
    failureReason: row.failureReason as MessageLogEntryDto['failureReason'],
    sendAt: row.sendAt.toISOString(),
    sentAt: iso(row.sentAt),
    deliveredAt: iso(row.deliveredAt),
    readAt: iso(row.readAt),
    attempts: row.attempts,
  };
}

async function manualResends(tx: Tx, appointmentId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(message)
    .where(and(eq(message.appointmentId, appointmentId), eq(message.trigger, 'manual')));
  return row?.n ?? 0;
}

export async function appointmentMessages(
  tx: Tx,
  appointmentId: string,
): Promise<AppointmentMessagesResponse> {
  const rows = await tx
    .select()
    .from(message)
    .where(eq(message.appointmentId, appointmentId))
    .orderBy(asc(message.createdAt), asc(message.id));
  const [open] = await tx
    .select({ id: worklistItem.id })
    .from(worklistItem)
    .where(
      and(
        eq(worklistItem.kind, 'reminder_not_sent'),
        eq(worklistItem.subjectType, 'appointment'),
        eq(worklistItem.subjectId, appointmentId),
        eq(worklistItem.status, 'open'),
      ),
    );
  return {
    messages: rows.map(toDto),
    noAutomatedReminders: open !== undefined,
    resendsLeft: Math.max(0, MAX_MANUAL_RESENDS - (await manualResends(tx, appointmentId))),
  };
}

export interface ResendDeps {
  /** Absent in a deployment without a queue: a resend answers "unavailable". */
  jobs: JobClient | undefined;
  clock: () => Date;
  quota?: QuotaPolicy | undefined;
  /** Whether a WhatsApp provider serves the organization. */
  whatsappAvailable(tenant: TenantRef): boolean;
}

/**
 * Sends the reminder of an appointment again on one channel, on purpose. Refuses when the
 * appointment is over, when the patient opted out of the channel, when the policy does not allow
 * the channel for this patient, and after the third resend.
 */
export async function resendReminder(
  deps: ResendDeps,
  tx: Tx,
  input: { appointmentId: string; channel: MessageChannel; actor: AuditActor },
): Promise<AppointmentMessagesResponse> {
  const { jobs } = deps;
  if (!jobs) throw new AppError('service_unavailable');
  const appointment = await loadAppointment(tx, input.appointmentId);
  if (!appointment) throw new AppError('not_found');
  const now = deps.clock();
  const live = appointment.status === 'scheduled' || appointment.status === 'confirmed';
  if (!live || appointment.startsAt.getTime() <= now.getTime()) {
    throw new AppError('resend_unavailable');
  }

  const sent = await manualResends(tx, input.appointmentId);
  if (sent >= MAX_MANUAL_RESENDS) throw new AppError('resend_limit_reached');

  const recipient = await loadRecipient(tx, appointment.patientId);
  const settings = await loadMessagingSettings(tx);
  const state = await loadTenantState(tx, await tenantIdOf(tx));
  if (!recipient || !state) throw new AppError('resend_unavailable');
  const tenant: TenantRef = { id: state.id, isDemo: state.isDemo };
  const decision = selectChannels('reminder', recipient.facts, {
    whatsappEnabled: settings.whatsappEnabled && deps.whatsappAvailable(tenant),
    whatsappQuotaAvailable: await whatsappQuotaAvailable(
      deps.quota ?? UNLIMITED_QUOTA,
      tx,
      appointment.professionalId,
      now,
    ),
  });
  if (!decision.channels.includes(input.channel)) {
    const skip = decision.skipped.find((entry) => entry.channel === input.channel)?.reason;
    throw new AppError(skip === 'opted_out' ? 'channel_opted_out' : 'resend_unavailable');
  }

  await queueMessage({ jobs, clock: deps.clock }, tx, {
    kind: 'reminder',
    channel: input.channel,
    patientId: appointment.patientId,
    appointmentId: appointment.id,
    professionalId: appointment.professionalId,
    plannedStartsAt: appointment.startsAt,
    appointmentVersion: appointment.version,
    sendAt: now,
    dedupeKey: dedupeKeyFor(`resend:${appointment.id}:${String(sent + 1)}`, input.channel),
    trigger: 'manual',
  });
  await audit(tx, {
    action: 'notification.resend',
    outcome: 'allow',
    actor: input.actor,
    resourceType: 'appointment',
    resourceId: appointment.id,
    patientId: appointment.patientId,
    metadata: { channel: input.channel, resend: sent + 1 },
  });
  return appointmentMessages(tx, input.appointmentId);
}

async function tenantIdOf(tx: Tx): Promise<string> {
  const result = await tx.execute<{ tenant: string }>(
    sql`select current_setting('app.tenant_id') as tenant`,
  );
  const tenantId = result.rows[0]?.tenant;
  if (!tenantId) throw new Error('This transaction has no tenant context');
  return tenantId;
}

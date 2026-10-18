import type { MessageChannel, MessageKind } from '@consultorio/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { message } from '../../../db/schema/notifications.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';

export const REMINDER_SEND_JOB = 'reminder.send';

/** What the sending job is given: the organization and the message to deliver. */
export const SendPayload = z.looseObject({ tenantId: z.uuid(), messageId: z.uuid() });
export type SendPayload = z.infer<typeof SendPayload>;

export interface QueueMessageInput {
  kind: MessageKind;
  channel: MessageChannel;
  patientId: string;
  appointmentId: string | null;
  professionalId: string | null;
  /** When the appointment starts: a move of the appointment makes the message stale. */
  plannedStartsAt: Date | null;
  appointmentVersion: number | null;
  /** When the message is due. A past or present time means "now". */
  sendAt: Date;
  /** Queueing the same key twice yields one message. */
  dedupeKey: string;
  trigger?: 'automatic' | 'manual';
}

export interface QueuedMessage {
  id: string;
  /** False when a message with that key already existed (nothing was enqueued). */
  created: boolean;
}

/**
 * The key of a message without its channel: the reminder of one appointment at one lead time,
 * whichever channel carried it. The channel is the last segment of every key.
 */
export function groupKeyOf(dedupeKey: string): string {
  return dedupeKey.slice(0, dedupeKey.lastIndexOf(':'));
}

export function dedupeKeyFor(groupKey: string, channel: MessageChannel): string {
  return `${groupKey}:${channel}`;
}

/**
 * Records a message as queued and enqueues the job that sends it, in the caller's transaction: a
 * rolled back booking leaves neither. Idempotent by `dedupeKey`. The send time is the job's
 * `startAfter`; the job re-reads the message and everything around it when it runs.
 */
export async function queueMessage(
  deps: { jobs: JobClient; clock: () => Date },
  tx: Tx,
  input: QueueMessageInput,
): Promise<QueuedMessage> {
  const [inserted] = await tx
    .insert(message)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      kind: input.kind,
      channel: input.channel,
      patientId: input.patientId,
      appointmentId: input.appointmentId,
      professionalId: input.professionalId,
      plannedStartsAt: input.plannedStartsAt,
      appointmentVersion: input.appointmentVersion,
      sendAt: input.sendAt,
      dedupeKey: input.dedupeKey,
      trigger: input.trigger ?? 'automatic',
    })
    .onConflictDoNothing()
    .returning({ id: message.id });

  if (!inserted) {
    const [existing] = await tx
      .select({ id: message.id })
      .from(message)
      .where(eq(message.dedupeKey, input.dedupeKey));
    if (!existing) throw new Error('message neither inserted nor found');
    return { id: existing.id, created: false };
  }

  const tenantId = (
    await tx.execute<{ tenant: string }>(sql`select current_setting('app.tenant_id') as tenant`)
  ).rows[0]?.tenant;
  if (!tenantId) throw new Error('This transaction has no tenant context');
  await deps.jobs.enqueue(
    tx,
    REMINDER_SEND_JOB,
    { tenantId, messageId: inserted.id },
    input.sendAt.getTime() > deps.clock().getTime() ? { startAfter: input.sendAt } : {},
  );
  return { id: inserted.id, created: true };
}

/** Whether a message of this group already exists on that channel (it was tried or is queued). */
export async function groupHasChannel(
  tx: Tx,
  groupKey: string,
  channel: MessageChannel,
): Promise<boolean> {
  const [found] = await tx
    .select({ id: message.id })
    .from(message)
    .where(and(eq(message.dedupeKey, dedupeKeyFor(groupKey, channel))));
  return found !== undefined;
}

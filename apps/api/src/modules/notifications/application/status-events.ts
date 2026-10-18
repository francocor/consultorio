import type { MessageFailureReason } from '@consultorio/contracts';
import { eq, sql } from 'drizzle-orm';

import { message, messageEvent } from '../../../db/schema/notifications.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { failAcceptedMessage } from './delivery.js';
import type { MessagingDeps } from './deps.js';
import type { WhatsAppEvent } from './ports.js';

type StatusEvent = Extract<WhatsAppEvent, { kind: 'status' }>;

export type StatusOutcome = 'applied' | 'duplicate' | 'stale' | 'unknown';

/** How far a message has got; a report that is not ahead of it changes nothing. */
const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };
const DELIVERED = 2;

/** What the provider's error code says about the address. Anything else is not the address's fault. */
function failureReasonOf(errorCode: string | undefined): MessageFailureReason {
  switch (errorCode) {
    case 'not_on_whatsapp':
    case 'invalid_number':
    case 'template_rejected':
      return errorCode;
    default:
      return 'delivery_failed';
  }
}

/**
 * Applies a delivery receipt to the message it is about (spec "Provider webhooks"). Idempotent by
 * the id of the provider's event: a replay finds its row and changes nothing. A message only moves
 * forward (sent, delivered, read); a late "delivered" after "read" is ignored. A failure after the
 * provider took the message follows the same road as a refusal: the other channel, or reception.
 *
 * `reactions` carries what the fallback needs (the queue, the worklist); without it a failure is
 * recorded and nothing more.
 */
export async function applyStatusEvent(
  tx: Tx,
  event: StatusEvent,
  reactions: MessagingDeps | undefined,
): Promise<StatusOutcome> {
  const [row] = await tx
    .select({ id: message.id, status: message.status, deliveredAt: message.deliveredAt })
    .from(message)
    .where(eq(message.providerMessageId, event.providerMessageId))
    .for('update');
  if (!row) return 'unknown';

  const [recorded] = await tx
    .insert(messageEvent)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      eventId: event.eventId,
      messageId: row.id,
      status: event.status,
    })
    .onConflictDoNothing()
    .returning({ id: messageEvent.id });
  if (!recorded) return 'duplicate';

  if (row.status === 'failed' || row.status === 'cancelled') return 'stale';

  if (event.status === 'failed') {
    const reason = failureReasonOf(event.errorCode);
    if (reactions)
      return (await failAcceptedMessage(reactions, tx, row.id, reason)) ? 'applied' : 'stale';
    await tx
      .update(message)
      .set({ status: 'failed', failureReason: reason })
      .where(eq(message.id, row.id));
    return 'applied';
  }

  const current = RANK[row.status] ?? 0;
  const next = RANK[event.status] ?? 0;
  if (next <= current) return 'stale';
  await tx
    .update(message)
    .set({
      status: event.status,
      ...(next >= DELIVERED && row.deliveredAt === null ? { deliveredAt: event.occurredAt } : {}),
      ...(event.status === 'read' ? { readAt: event.occurredAt } : {}),
    })
    .where(eq(message.id, row.id));
  return 'applied';
}

import type { AuditAction, AuditMetadata } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';

import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';

const NO_ONE: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

/**
 * Who a change made inside an event handler or a job is attributed to: the person whose request
 * caused it (the member who rescheduled or cancelled), or nobody when the system acted. The
 * transaction already carries the answer (`app.user_id`).
 */
export async function actorOfTransaction(tx: Tx): Promise<AuditActor> {
  const result = await tx.execute<{ user: string | null }>(
    sql`select nullif(current_setting('app.user_id', true), '') as "user"`,
  );
  const user = result.rows[0]?.user ?? null;
  return user === null || user === SYSTEM_USER_ID ? NO_ONE : { ...NO_ONE, userId: user };
}

/**
 * Writes the audit entry of a link event. The entry names the appointment and the event, never the
 * link: the metadata schema refuses a token key, and the room name and the manual address are left
 * out too, because anyone holding them could open the call.
 */
export async function auditLinkEvent(
  tx: Tx,
  input: {
    action: AuditAction;
    appointmentId: string;
    actor?: AuditActor;
    metadata?: AuditMetadata;
  },
): Promise<void> {
  await audit(tx, {
    action: input.action,
    outcome: 'allow',
    actor: input.actor ?? (await actorOfTransaction(tx)),
    resourceType: 'appointment',
    resourceId: input.appointmentId,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
}

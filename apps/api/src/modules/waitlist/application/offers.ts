import { and, eq, sql } from 'drizzle-orm';

import {
  waitlistEntry,
  waitlistOffer,
  type WaitlistEntryRow,
  type WaitlistOfferRow,
} from '../../../db/schema/waitlist.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { currentTenantId, type Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';

export const WAITLIST_OFFER_JOB = 'waitlist.offer';
export const WAITLIST_EXPIRE_JOB = 'waitlist.expire';

/** The system acts: matching, delivery and expiry run with nobody signed in. */
export const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

/** Names a slot: who, where and when it starts. Two offers for it can never be open at once. */
export function slotKeyOf(slot: {
  professionalId: string;
  locationId: string;
  startsAt: Date;
}): string {
  return `${slot.professionalId}|${slot.locationId}|${String(slot.startsAt.getTime())}`;
}

export interface NewOffer {
  entry: WaitlistEntryRow;
  professionalId: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  /** The range that was freed, kept so the next entry can be offered the same slot. */
  freed: { startsAt: Date; endsAt: Date };
  sendAt: Date;
  expiresAt: Date;
  now: Date;
}

/**
 * Makes an offer: the row, the entry waiting for an answer, the audit entry, and the two jobs that
 * follow (the delivery at `sendAt` and the expiry at `expiresAt`), all in the transaction of the
 * match, so an offer exists with its jobs or not at all. Returns null when the slot is already
 * offered to somebody (two matches racing) or the entry no longer waits, in which case nothing was
 * written.
 */
export async function createOffer(
  tx: Tx,
  deps: { jobs: JobClient },
  input: NewOffer,
): Promise<WaitlistOfferRow | null> {
  const { entry } = input;
  // The entry is locked and read again: the match read it a while ago, and reception or the patient
  // may have closed it since. An offer for an entry that no longer waits would be sent to a patient
  // who asked to be taken off the list.
  const [current] = await tx
    .select({ status: waitlistEntry.status })
    .from(waitlistEntry)
    .where(eq(waitlistEntry.id, entry.id))
    .for('update');
  if (current?.status !== 'active') return null;
  let created: WaitlistOfferRow | undefined;
  try {
    [created] = await tx.transaction((inner) =>
      inner
        .insert(waitlistOffer)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          entryId: entry.id,
          patientId: entry.patientId,
          slotKey: slotKeyOf({
            professionalId: input.professionalId,
            locationId: input.locationId,
            startsAt: input.startsAt,
          }),
          professionalId: input.professionalId,
          locationId: input.locationId,
          appointmentTypeId: entry.appointmentTypeId,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          freedStartsAt: input.freed.startsAt,
          freedEndsAt: input.freed.endsAt,
          sendAt: input.sendAt,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        })
        .returning(),
    );
  } catch (error) {
    // The slot is already offered, or this entry or patient already had it: nothing to do.
    if ((error as { cause?: { code?: string } }).cause?.code === '23505') return null;
    throw error;
  }
  if (!created) return null;

  await tx
    .update(waitlistEntry)
    .set({ status: 'offered' })
    .where(and(eq(waitlistEntry.id, entry.id), eq(waitlistEntry.status, 'active')));
  await audit(tx, {
    action: 'waitlist.offer.created',
    outcome: 'allow',
    actor: SYSTEM_ACTOR,
    resourceType: 'waitlist_offer',
    resourceId: created.id,
    patientId: entry.patientId,
    metadata: {
      entryId: entry.id,
      startsAt: input.startsAt.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      priority: entry.priority,
    },
  });

  const tenantId = await currentTenantId(tx);
  await deps.jobs.enqueue(
    tx,
    WAITLIST_OFFER_JOB,
    { tenantId, offerId: created.id },
    input.sendAt.getTime() > input.now.getTime() ? { startAfter: input.sendAt } : {},
  );
  await deps.jobs.enqueue(
    tx,
    WAITLIST_EXPIRE_JOB,
    { tenantId, offerId: created.id },
    { startAfter: input.expiresAt },
  );
  return created;
}

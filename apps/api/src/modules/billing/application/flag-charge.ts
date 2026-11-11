import type { ChargeReviewReason } from '@consultorio/contracts';
import { and, eq, ne } from 'drizzle-orm';

import { charge } from '../../../db/schema/billing-charges.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { AppointmentEvent } from '../../../platform/events/appointment-events.js';

/** The system acts here: nobody pressed a button in billing. */
const SYSTEM: AuditActor = {
  userId: null,
  actingRole: null,
  ip: null,
  userAgent: null,
  requestId: null,
};

function endedWithoutService(
  event: AppointmentEvent,
): { reason: ChargeReviewReason; appointmentId: string } | undefined {
  if (event.kind === 'cancelled') {
    return { reason: 'cancelled', appointmentId: event.appointment.appointmentId };
  }
  if (event.kind === 'status_changed' && event.appointment.status === 'no_show') {
    return { reason: 'no_show', appointmentId: event.appointment.appointmentId };
  }
  return undefined;
}

/**
 * A subscriber of the appointment events (billing-payments, "Appointment ends without service after
 * charge capture"): an appointment that becomes a no-show or is cancelled flags its charge for a
 * person to look at. It never voids or refunds anything: that is a decision for someone who may
 * make it, under the void and refund rules. Runs in the transaction of the scheduling change, so
 * the flag and the new status commit together.
 */
export async function flagChargeForReview(tx: Tx, event: AppointmentEvent): Promise<void> {
  const ended = endedWithoutService(event);
  if (ended === undefined) return;
  const { reason, appointmentId } = ended;

  const flagged = await tx
    .update(charge)
    .set({ needsReview: true, reviewReason: reason, flaggedAt: new Date() })
    .where(
      and(
        eq(charge.appointmentId, appointmentId),
        ne(charge.status, 'voided'),
        eq(charge.needsReview, false),
      ),
    )
    .returning({ id: charge.id, patientId: charge.patientId });

  for (const row of flagged) {
    await audit(tx, {
      action: 'charge.flagged',
      outcome: 'allow',
      actor: SYSTEM,
      resourceType: 'charge',
      resourceId: row.id,
      patientId: row.patientId,
      metadata: { reason, appointmentId },
    });
  }
}

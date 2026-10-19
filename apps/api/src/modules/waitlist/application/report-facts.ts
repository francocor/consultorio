import { and, eq, gte, isNotNull, lt } from 'drizzle-orm';

import { appointment } from '../../../db/schema/scheduling.js';
import { waitlistOffer } from '../../../db/schema/waitlist.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

const DAY_MS = 86_400_000;

/**
 * The appointments that were recovered through the waitlist (reports, "slots recovered through the
 * waitlist"): the ones an accepted offer became. The reports module counts and lists them with its
 * own scope and filters, so a figure and the records behind it share one definition.
 *
 * The window is the calendar days of the report padded by a day on each side, because the days are
 * read at the zone of each location (at most 14 hours from UTC); the report applies the exact days.
 * The appointment is read only for its start, so a recovered slot that was later moved counts where
 * it is now.
 */
export async function recoveredAppointmentIds(
  tx: Tx,
  period: { fromDate: string; toDate: string },
): Promise<string[]> {
  const from = new Date(Date.parse(`${period.fromDate}T00:00:00Z`) - DAY_MS);
  const to = new Date(Date.parse(`${period.toDate}T00:00:00Z`) + 2 * DAY_MS);
  const rows = await tx
    .select({ appointmentId: waitlistOffer.appointmentId })
    .from(waitlistOffer)
    .innerJoin(
      appointment,
      and(
        eq(appointment.tenantId, waitlistOffer.tenantId),
        eq(appointment.id, waitlistOffer.appointmentId),
      ),
    )
    .where(
      and(
        eq(waitlistOffer.status, 'accepted'),
        isNotNull(waitlistOffer.appointmentId),
        gte(appointment.startsAt, from),
        lt(appointment.startsAt, to),
      ),
    );
  return rows.flatMap((row) => (row.appointmentId === null ? [] : [row.appointmentId]));
}

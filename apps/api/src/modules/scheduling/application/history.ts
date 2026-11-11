import type { AppointmentHistoryResponse } from '@consultorio/contracts';
import { asc, eq } from 'drizzle-orm';

import { appointment, appointmentEvent } from '../../../db/schema/scheduling.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';

type EventDto = AppointmentHistoryResponse['events'][number];

/**
 * The history of one appointment, oldest first. "Rescheduled" is not a status: how many times an
 * appointment was moved is counted here, from its events (what the reports count).
 */
export async function appointmentHistory(
  tx: Tx,
  appointmentId: string,
): Promise<AppointmentHistoryResponse> {
  const [exists] = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(eq(appointment.id, appointmentId));
  if (!exists) throw new AppError('not_found');

  const rows = await tx
    .select()
    .from(appointmentEvent)
    .where(eq(appointmentEvent.appointmentId, appointmentId))
    .orderBy(asc(appointmentEvent.createdAt), asc(appointmentEvent.id));
  const events = rows.map((row): EventDto => ({
    id: row.id,
    kind: row.kind as EventDto['kind'],
    fromStatus: row.fromStatus as EventDto['fromStatus'],
    toStatus: row.toStatus as EventDto['toStatus'],
    actorUserId: row.actorUserId,
    actorKind: row.actorKind as EventDto['actorKind'],
    at: row.createdAt.toISOString(),
    details: row.details,
  }));
  return {
    appointmentId,
    rescheduledCount: events.filter((event) => event.kind === 'rescheduled').length,
    events,
  };
}

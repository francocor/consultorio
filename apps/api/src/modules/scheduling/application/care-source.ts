import { eq } from 'drizzle-orm';

import { appointment } from '../../../db/schema/scheduling.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/** Statuses of an appointment that count for the care relationship (migration 0027). */
const COUNTING_STATUSES: ReadonlySet<string> = new Set([
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'attended',
  'no_show',
]);

export interface CareSourceAppointment {
  patientId: string;
  professionalId: string;
  /** Whether a person confirmed who the patient is (D14, D18). */
  identityConfirmed: boolean;
  /** Whether the status still counts as a care source: not cancelled, not awaiting approval. */
  counts: boolean;
}

/**
 * Finds an appointment as the care relationship sees it, inside the transaction of the request (so
 * row level security applies: an appointment the caller cannot see is `null`). The clinical module
 * receives this as a port to check the appointment an encounter is opened from.
 */
export async function findCareSourceAppointment(
  tx: Tx,
  appointmentId: string,
): Promise<CareSourceAppointment | null> {
  const [row] = await tx
    .select({
      patientId: appointment.patientId,
      professionalId: appointment.professionalId,
      identityConfirmed: appointment.identityConfirmed,
      status: appointment.status,
    })
    .from(appointment)
    .where(eq(appointment.id, appointmentId));
  if (!row) return null;
  return {
    patientId: row.patientId,
    professionalId: row.professionalId,
    identityConfirmed: row.identityConfirmed,
    counts: COUNTING_STATUSES.has(row.status),
  };
}

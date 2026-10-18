import { isAppointmentStatus, type AppointmentStatus } from '@consultorio/contracts';
import { eq, inArray } from 'drizzle-orm';

import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * An appointment as billing needs it to charge for it: its status (a charge starts at check-in),
 * who and where, the type, and when and in which time zone it happens (the day of the service picks
 * the price). Administrative data only, nothing clinical.
 */
export interface AppointmentForCharge {
  id: string;
  status: AppointmentStatus;
  patientId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  appointmentTypeName: string;
  startsAt: Date;
  endsAt: Date;
  locationTimeZone: string;
  /** Set when the appointment was cancelled too late for the organization's rule; null before. */
  lateCancellation: boolean | null;
}

/**
 * Reads appointments for billing, in the organization of the transaction (an appointment of another
 * organization is not found). The list keeps the order of the ids that exist.
 */
export async function readAppointmentsForCharge(
  tx: Tx,
  appointmentIds: readonly string[],
): Promise<AppointmentForCharge[]> {
  if (appointmentIds.length === 0) return [];
  const rows = await tx
    .select({
      id: appointment.id,
      status: appointment.status,
      patientId: appointment.patientId,
      professionalId: appointment.professionalId,
      locationId: appointment.locationId,
      appointmentTypeId: appointment.appointmentTypeId,
      appointmentTypeName: appointmentType.name,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      locationTimeZone: location.timeZone,
      lateCancellation: appointment.lateCancellation,
    })
    .from(appointment)
    .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId))
    .innerJoin(location, eq(location.id, appointment.locationId))
    .where(inArray(appointment.id, [...appointmentIds]));
  return rows.flatMap((row) =>
    isAppointmentStatus(row.status) ? [{ ...row, status: row.status }] : [],
  );
}

/** One appointment for billing, or `null` when the organization has no such appointment. */
export async function readAppointmentForCharge(
  tx: Tx,
  appointmentId: string,
): Promise<AppointmentForCharge | null> {
  const [found] = await readAppointmentsForCharge(tx, [appointmentId]);
  return found ?? null;
}

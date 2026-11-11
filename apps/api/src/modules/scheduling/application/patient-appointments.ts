import type { AppointmentStatus } from '@consultorio/contracts';
import { and, asc, desc, eq, gt, lte } from 'drizzle-orm';

import { membership } from '../../../db/schema/identity.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { appointment } from '../../../db/schema/scheduling.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * An appointment as the patient sees it in the portal (Stage 5, patient-portal "Appointments in the
 * portal"): when, with whom, where, what kind and in what state. Nothing about how it was booked,
 * the identity review, an override or a note: those are the staff's.
 */
export interface PatientAppointmentView {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  version: number;
  professionalName: string;
  locationName: string;
  timeZone: string;
  typeName: string;
  mode: 'in_person' | 'virtual';
}

/** The most past appointments one list returns: a patient looks at the recent ones. */
const PAST_LIMIT = 50;

const SELECTION = {
  id: appointment.id,
  startsAt: appointment.startsAt,
  endsAt: appointment.endsAt,
  status: appointment.status,
  version: appointment.version,
  professionalName: membership.displayName,
  locationName: location.name,
  timeZone: location.timeZone,
  typeName: appointmentType.name,
  mode: appointmentType.mode,
};

function toView(row: {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  version: number;
  professionalName: string | null;
  locationName: string;
  timeZone: string;
  typeName: string;
  mode: string;
}): PatientAppointmentView {
  return {
    id: row.id,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status as AppointmentStatus,
    version: row.version,
    professionalName: row.professionalName?.trim() || 'Profesional',
    locationName: row.locationName,
    timeZone: row.timeZone,
    typeName: row.typeName,
    mode: row.mode === 'virtual' ? 'virtual' : 'in_person',
  };
}

function base(tx: Tx) {
  return tx
    .select(SELECTION)
    .from(appointment)
    .innerJoin(professional, eq(professional.id, appointment.professionalId))
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .innerJoin(location, eq(location.id, appointment.locationId))
    .innerJoin(appointmentType, eq(appointmentType.id, appointment.appointmentTypeId));
}

/**
 * The upcoming appointments of a patient (soonest first) and their latest past ones (newest
 * first). The patient is the argument: the portal derives it from the session, never from the
 * request.
 */
export async function listPatientAppointments(
  tx: Tx,
  input: { patientId: string; now: Date },
): Promise<{ upcoming: PatientAppointmentView[]; past: PatientAppointmentView[] }> {
  const upcoming = await base(tx)
    .where(and(eq(appointment.patientId, input.patientId), gt(appointment.endsAt, input.now)))
    .orderBy(asc(appointment.startsAt), asc(appointment.id));
  const past = await base(tx)
    .where(and(eq(appointment.patientId, input.patientId), lte(appointment.endsAt, input.now)))
    .orderBy(desc(appointment.startsAt), desc(appointment.id))
    .limit(PAST_LIMIT);
  return { upcoming: upcoming.map(toView), past: past.map(toView) };
}

/** One appointment of the patient, or null when it does not exist or belongs to somebody else. */
export async function findPatientAppointment(
  tx: Tx,
  input: { appointmentId: string; patientId: string },
): Promise<PatientAppointmentView | null> {
  const [row] = await base(tx).where(
    and(eq(appointment.id, input.appointmentId), eq(appointment.patientId, input.patientId)),
  );
  return row ? toView(row) : null;
}

import type { AppointmentDto, BookAppointmentRequest } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import { AppError } from '../../../platform/http/problem.js';

import {
  applyPlan,
  conflictAfterRace,
  invalid,
  planSlot,
  resolveStart,
  type BookActor,
  type PlanInput,
} from './placement.js';
import type { LocationRecord, ProfessionalRecord, SchedulingPorts, TypeRecord } from './ports.js';

export { SlotTakenError, invalid } from './placement.js';
export type { BookActor } from './placement.js';

export interface BookInput {
  request: BookAppointmentRequest;
  actor: BookActor;
  auditActor: AuditActor;
  now: Date;
  /**
   * Called once the location is known to exist, so a location the actor may not operate is refused
   * as a denial, and one that does not exist (or belongs to another organization) as not found.
   */
  authorizeLocation?: (location: LocationRecord) => Promise<void>;
}

/** The professional offers this type (restricted by professional or specialty, or open to all). */
export function typeOffered(type: TypeRecord, professional: ProfessionalRecord): boolean {
  if (type.professionalIds.length > 0 && !type.professionalIds.includes(professional.id)) {
    return false;
  }
  return (
    type.specialties.length === 0 ||
    type.specialties.some((specialty) => professional.specialties.includes(specialty))
  );
}

/**
 * Books an appointment for an existing patient (scheduling, "Booking an appointment"). Everything
 * runs in the caller's transaction, after the row lock on the professional that serializes their
 * writes (design 4.6). The rules, in order:
 *
 * 1. the professional, location, type and patient exist in the organization (another
 *    organization's ids look like missing ones) and are active;
 * 2. the type is offered by the professional;
 * 3. past, hours, blocks, holidays, capacity and holds: `planSlot`, shared with every other way of
 *    taking time;
 * 4. the insert; if the database still refuses an overlap (a race that slipped through), the same
 *    conflict answer is produced.
 */
export async function bookAppointment(
  ports: SchedulingPorts,
  input: BookInput,
): Promise<AppointmentDto> {
  const { request, actor, now } = input;

  const professional = await ports.lockProfessional(request.professionalId);
  // One after the other: a transaction has one connection, and it runs one query at a time.
  const location = await ports.findLocation(request.locationId);
  const type = await ports.findType(request.appointmentTypeId);
  const patient = await ports.findPatient(request.patientId);
  if (!professional || !location || !type || !patient) throw new AppError('not_found');
  if (
    professional.status !== 'active' ||
    !location.active ||
    !type.active ||
    patient.status !== 'active'
  ) {
    throw new AppError('conflict');
  }
  if (input.authorizeLocation) await input.authorizeLocation(location);
  if (!typeOffered(type, professional)) {
    throw invalid('appointmentTypeId', 'scheduling.booking.type_not_offered');
  }

  const planInput: PlanInput = {
    professional,
    location,
    durationMinutes: type.durationMinutes,
    bufferMinutes: type.bufferMinutes,
    startsAt: resolveStart(request, location),
    actor,
    now,
    overrideHours: request.overrideHours,
    overrideHold: request.overrideHold,
    checkPast: true,
    checkHours: true,
  };
  const plan = await planSlot(ports, planInput);
  await applyPlan(ports, plan);

  const inserted = await ports.insertAppointment({
    patientId: patient.id,
    professionalId: professional.id,
    locationId: location.id,
    appointmentTypeId: type.id,
    startsAt: new Date(plan.range.start),
    endsAt: new Date(plan.range.end),
    bufferMinutes: type.bufferMinutes,
    lane: plan.lane,
    status: 'scheduled',
    source: 'staff',
    bookedBy: actor.userId,
    identityConfirmed: true,
    outOfHours: plan.outOfHours,
    overrideReason: plan.overrideReason,
  });
  if (!inserted.ok) throw await conflictAfterRace(ports, planInput, plan);
  const { appointment } = inserted;

  await ports.insertEvent({
    appointmentId: appointment.id,
    kind: 'created',
    toStatus: appointment.status,
    actorUserId: actor.userId,
    actorKind: 'staff',
    details: plan.overrides.length > 0 ? { overrides: plan.overrides } : {},
  });
  await ports.audit({
    action: 'appointment.created',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'appointment',
    resourceId: appointment.id,
    patientId: patient.id,
    metadata: {
      professionalId: professional.id,
      locationId: location.id,
      startsAt: appointment.startsAt,
    },
  });
  if (plan.overrides.length > 0) {
    await ports.audit({
      action: 'appointment.overridden',
      outcome: 'allow',
      actor: input.auditActor,
      resourceType: 'appointment',
      resourceId: appointment.id,
      patientId: patient.id,
      metadata: {
        kinds: plan.overrides,
        ...(plan.overrideReason === null ? {} : { overrideReason: plan.overrideReason }),
      },
    });
  }
  return appointment;
}

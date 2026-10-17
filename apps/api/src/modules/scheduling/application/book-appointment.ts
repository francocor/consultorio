import type { AppointmentDto, BookAppointmentRequest } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import { AppError } from '../../../platform/http/problem.js';
import { initialIdentityConfirmed } from '../domain/identity-confirmation.js';

import {
  applyPlan,
  assertCalendar,
  conflictAfterRace,
  invalid,
  planSlot,
  resolveStart,
  SlotNoLongerAvailableError,
  typeOffered,
  type BookActor,
  type LocationAuthorizer,
  type Plan,
  type PlanInput,
} from './placement.js';
import type {
  HoldRecord,
  LocationRecord,
  PatientRecord,
  ProfessionalRecord,
  SchedulingPorts,
  TypeRecord,
} from './ports.js';

export { SlotNoLongerAvailableError, SlotTakenError, invalid, typeOffered } from './placement.js';
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
  authorizeLocation?: LocationAuthorizer;
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
  assertCalendar(actor, professional.id);
  if (input.authorizeLocation) await input.authorizeLocation(location, professional.id);
  if (!typeOffered(type, professional)) {
    throw invalid('appointmentTypeId', 'scheduling.booking.type_not_offered');
  }

  const startsAt = resolveStart(request, location);

  // Finishing a hold: it must still be active (a staff override or the clock may have ended it) and
  // be the range being booked. Its own occupancy does not count against the booking.
  let hold: HoldRecord | null = null;
  if (request.holdId !== undefined) {
    await ports.expireHolds(professional.id, now);
    hold = await ports.findHold(request.holdId, { lock: true });
    // A hold belongs to whoever made it: anyone else's looks like it does not exist.
    if (hold?.sourceKey !== actor.userId) throw new AppError('not_found');
    if (hold.status !== 'active') throw new SlotNoLongerAvailableError();
    if (
      hold.professionalId !== professional.id ||
      hold.locationId !== location.id ||
      hold.startsAt.getTime() !== startsAt.getTime()
    ) {
      throw invalid('holdId', 'scheduling.hold.mismatch');
    }
  }

  const planInput: PlanInput = {
    professional,
    location,
    durationMinutes: type.durationMinutes,
    bufferMinutes: type.bufferMinutes,
    startsAt,
    actor,
    now,
    overrideHours: request.overrideHours,
    overrideHold: request.overrideHold,
    checkPast: true,
    checkHours: true,
    ...(hold ? { ignoreHoldId: hold.id } : {}),
  };
  const plan = await planSlot(ports, planInput);
  await applyPlan(ports, planInput, plan);
  // The hold stops occupying the range before the appointment takes it (one lane, one occupant).
  if (hold) await ports.updateHold(hold.id, { status: 'converted' });

  const appointment = await persistAppointment(ports, {
    professional,
    location,
    type,
    patient,
    actor,
    auditActor: input.auditActor,
    now,
    plan,
    planInput,
    hold,
  });
  return appointment;
}

export interface PersistInput {
  professional: ProfessionalRecord;
  location: LocationRecord;
  type: TypeRecord;
  patient: PatientRecord;
  actor: BookActor;
  auditActor: AuditActor;
  now: Date;
  plan: Plan;
  planInput: PlanInput;
  /** The hold this booking finishes, already marked converted. */
  hold?: HoldRecord | null;
  /** The series the appointment belongs to, and which session it is. */
  series?: { seriesId: string; index: number };
  /**
   * Whether the patient was registered by the actor a moment ago, when the caller already judged
   * it. A series judges it once before its first session exists: afterwards the patient has an
   * appointment and would no longer look new.
   */
  freshPatient?: boolean;
}

/**
 * Writes a planned appointment: the row, the identity review when it starts unconfirmed (D14), the
 * history event and the audit trail. Shared by a single booking and by every session of a series.
 */
export async function persistAppointment(
  ports: SchedulingPorts,
  input: PersistInput,
): Promise<AppointmentDto> {
  const { professional, location, type, patient, actor, now, plan, planInput, hold } = input;
  // D14: attaching an appointment to an EXISTING patient without anybody checking who the patient
  // is (the professional booking themselves) leaves the identity unconfirmed. A patient the actor
  // registered a moment ago is not a match.
  const identityConfirmed = initialIdentityConfirmed({
    source: 'staff',
    patient:
      (input.freshPatient ?? (await ports.isFreshPatient(patient.id, actor.userId, now)))
        ? 'created'
        : 'existing',
    bookingActorProfessionalId: actor.professionalId,
    appointmentProfessionalId: professional.id,
  });

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
    identityConfirmed,
    outOfHours: plan.outOfHours,
    overrideReason: plan.overrideReason,
    seriesId: input.series?.seriesId ?? null,
    seriesIndex: input.series?.index ?? null,
  });
  if (!inserted.ok) throw await conflictAfterRace(ports, planInput, plan);
  const { appointment } = inserted;
  if (hold) await ports.updateHold(hold.id, { appointmentId: appointment.id });

  if (!identityConfirmed) {
    await ports.openWorklistItem({
      kind: 'identity_review',
      subjectType: 'appointment',
      subjectId: appointment.id,
      locationId: location.id,
    });
  }
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
      identityConfirmed,
      ...(input.series ? { seriesIndex: input.series.index } : {}),
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

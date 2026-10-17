import { randomUUID } from 'node:crypto';

import type {
  AppointmentDto,
  AppointmentStatus,
  CancelledBy,
  CancellationReason,
  LocalStart,
  OverrideHours,
} from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import {
  canCorrect,
  canReschedule,
  canTransition,
  occupiesTime,
} from '../domain/appointment-state-machine.js';

import { typeOffered } from './book-appointment.js';
import {
  applyPlan,
  conflictAfterRace,
  invalid,
  planSlot,
  resolveStart,
  type BookActor,
  type PlanInput,
} from './placement.js';
import type {
  AppointmentPatch,
  AppointmentRecord,
  LocationRecord,
  ProfessionalRecord,
  SchedulingPorts,
} from './ports.js';

export type TransitionAction =
  'confirm' | 'check_in' | 'start' | 'attend' | 'no_show' | 'cancel' | 'approve';

const TARGET: Record<TransitionAction, AppointmentStatus> = {
  confirm: 'confirmed',
  check_in: 'checked_in',
  start: 'in_progress',
  attend: 'attended',
  no_show: 'no_show',
  cancel: 'cancelled',
  approve: 'scheduled',
};

const HOUR_MS = 3_600_000;

/**
 * Locks what a change to one appointment must serialize with: the professional(s) first, in a fixed
 * order so two moves cannot deadlock, then the appointment itself. Returns the locked row.
 */
async function lockForChange(
  ports: SchedulingPorts,
  appointmentId: string,
  alsoProfessionalIds: readonly string[] = [],
): Promise<AppointmentRecord> {
  const peek = await ports.findAppointment(appointmentId);
  if (!peek) throw new AppError('not_found');
  const ids = [...new Set([peek.professionalId, ...alsoProfessionalIds])].sort();
  for (const id of ids) await ports.lockProfessional(id);
  const record = await ports.findAppointment(appointmentId, { lock: true });
  if (!record) throw new AppError('not_found');
  return record;
}

function checkVersion(record: AppointmentRecord, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && expectedVersion !== record.version) {
    throw new AppError('stale_revision');
  }
}

export interface TransitionInput {
  appointmentId: string;
  action: TransitionAction;
  actor: BookActor;
  auditActor: AuditActor;
  now: Date;
  expectedVersion?: number | undefined;
  cancellation?: { cancelledBy: CancelledBy; reasonCode: CancellationReason; note?: string };
}

/**
 * One step of the attendance lifecycle: confirm, check in, start, attend, no-show, cancel or
 * approve. The state machine decides what is allowed; the version guards against a stale screen;
 * every change writes the history and the audit trail in the same transaction.
 */
export async function transitionAppointment(
  ports: SchedulingPorts,
  input: TransitionInput,
): Promise<AppointmentDto> {
  const record = await lockForChange(ports, input.appointmentId);
  checkVersion(record, input.expectedVersion);

  // Only the professional of the appointment starts or finishes it: that is clinical work.
  if (
    (input.action === 'start' || input.action === 'attend') &&
    input.actor.professionalId !== record.professionalId
  ) {
    throw new AccessRefused('not_the_appointment_professional');
  }

  const target = TARGET[input.action];
  if (!canTransition(record.status, target)) throw new AppError('conflict');
  if (input.action === 'no_show' && input.now.getTime() < record.startsAt.getTime()) {
    throw invalid('status', 'scheduling.transition.no_show_too_early');
  }

  const patch: AppointmentPatch = { status: target };
  let late = false;
  if (input.action === 'cancel') {
    if (!input.cancellation) throw invalid('cancelledBy', 'scheduling.cancel.details_required');
    const windowHours = await ports.lateCancellationHours();
    late = record.startsAt.getTime() - input.now.getTime() < windowHours * HOUR_MS;
    Object.assign(patch, {
      cancelledByKind: input.cancellation.cancelledBy,
      cancelReason: input.cancellation.reasonCode,
      cancelNote: input.cancellation.note ?? null,
      cancelledAt: input.now,
      lateCancellation: late,
      // The video link stops working with the appointment.
      videoRoom: null,
    } satisfies AppointmentPatch);
  }

  const updated = await ports.updateAppointment(record.id, patch);
  await ports.insertEvent({
    appointmentId: record.id,
    kind: 'status_changed',
    fromStatus: record.status,
    toStatus: target,
    actorUserId: input.actor.userId,
    actorKind: 'staff',
    ...(input.cancellation
      ? {
          details: {
            cancelledBy: input.cancellation.cancelledBy,
            reasonCode: input.cancellation.reasonCode,
            late,
          },
        }
      : {}),
  });
  await ports.audit(
    input.action === 'cancel' && input.cancellation
      ? {
          action: 'appointment.cancelled',
          outcome: 'allow',
          actor: input.auditActor,
          resourceType: 'appointment',
          resourceId: record.id,
          patientId: record.patientId,
          // Codes and a flag; the free text of the cancellation never goes to the trail.
          metadata: {
            from: record.status,
            cancelledBy: input.cancellation.cancelledBy,
            reasonCode: input.cancellation.reasonCode,
            late,
          },
        }
      : {
          action: 'appointment.status_changed',
          outcome: 'allow',
          actor: input.auditActor,
          resourceType: 'appointment',
          resourceId: record.id,
          patientId: record.patientId,
          metadata: { from: record.status, to: target },
        },
  );
  return updated;
}

export interface CorrectInput {
  appointmentId: string;
  toStatus: AppointmentStatus;
  reason: string;
  actor: BookActor;
  auditActor: AuditActor;
  now: Date;
  expectedVersion?: number | undefined;
}

/**
 * An authorized correction of a terminal status (for example a no-show marked by mistake). A
 * correction to a status that takes the professional's time is validated like a booking and is
 * refused when the range was taken meanwhile.
 */
export async function correctStatus(
  ports: SchedulingPorts,
  input: CorrectInput,
): Promise<AppointmentDto> {
  const record = await lockForChange(ports, input.appointmentId);
  checkVersion(record, input.expectedVersion);
  if (!canCorrect(record.status, input.toStatus)) throw new AppError('conflict');

  const patch: AppointmentPatch = { status: input.toStatus };
  if (!occupiesTime(record.status) && occupiesTime(input.toStatus)) {
    const professional = await ports.lockProfessional(record.professionalId);
    const location = await ports.findLocation(record.locationId);
    if (!professional || !location) throw new AppError('not_found');
    const planInput: PlanInput = {
      professional,
      location,
      durationMinutes: Math.round((record.endsAt.getTime() - record.startsAt.getTime()) / 60_000),
      bufferMinutes: record.bufferMinutes,
      startsAt: record.startsAt,
      actor: input.actor,
      now: input.now,
      ignoreAppointmentId: record.id,
      // The past stays the past, and the hours were settled when it was booked.
      checkPast: false,
      checkHours: false,
    };
    const plan = await planSlot(ports, planInput);
    await applyPlan(ports, plan);
    patch.lane = plan.lane;
  }
  if (record.status === 'cancelled') {
    Object.assign(patch, {
      cancelledByKind: null,
      cancelReason: null,
      cancelNote: null,
      cancelledAt: null,
      lateCancellation: null,
    } satisfies AppointmentPatch);
  }

  const updated = await ports.updateAppointment(record.id, patch);
  await ports.insertEvent({
    appointmentId: record.id,
    kind: 'status_corrected',
    fromStatus: record.status,
    toStatus: input.toStatus,
    actorUserId: input.actor.userId,
    actorKind: 'staff',
    details: { reason: input.reason },
  });
  await ports.audit({
    action: 'appointment.status_corrected',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'appointment',
    resourceId: record.id,
    patientId: record.patientId,
    metadata: { from: record.status, to: input.toStatus, reason: input.reason },
  });
  return updated;
}

export interface RescheduleInput {
  appointmentId: string;
  expectedVersion: number;
  startsAt?: string | undefined;
  local?: LocalStart | undefined;
  professionalId?: string | undefined;
  locationId?: string | undefined;
  overrideHours?: OverrideHours | undefined;
  overrideHold?: boolean | undefined;
  actor: BookActor;
  auditActor: AuditActor;
  now: Date;
  authorizeLocation?: (location: LocationRecord) => Promise<void>;
}

/**
 * Moves an appointment to another time, location or professional, with the validations of a
 * booking. The original time is kept in the history ("rescheduled" is an event, not a status). A
 * virtual appointment gets a new video room, so the old link stops working.
 */
export async function rescheduleAppointment(
  ports: SchedulingPorts,
  input: RescheduleInput,
): Promise<AppointmentDto> {
  const record = await lockForChange(
    ports,
    input.appointmentId,
    input.professionalId ? [input.professionalId] : [],
  );
  checkVersion(record, input.expectedVersion);
  if (!canReschedule(record.status)) throw new AppError('conflict');

  const professionalId = input.professionalId ?? record.professionalId;
  const professional: ProfessionalRecord | null = await ports.lockProfessional(professionalId);
  const location = await ports.findLocation(input.locationId ?? record.locationId);
  const type = await ports.findType(record.appointmentTypeId);
  if (!professional || !location || !type) throw new AppError('not_found');
  if (professional.status !== 'active' || !location.active) throw new AppError('conflict');
  if (input.authorizeLocation) await input.authorizeLocation(location);

  const professionalChanged = professional.id !== record.professionalId;
  if (professionalChanged && !typeOffered(type, professional)) {
    throw invalid('professionalId', 'scheduling.booking.type_not_offered');
  }

  const timeGiven = input.startsAt !== undefined || input.local !== undefined;
  const startsAt = timeGiven
    ? resolveStart({ startsAt: input.startsAt, local: input.local }, location)
    : record.startsAt;
  const durationMinutes = Math.round(
    (record.endsAt.getTime() - record.startsAt.getTime()) / 60_000,
  );
  const timeChanged = startsAt.getTime() !== record.startsAt.getTime();
  const locationChanged = location.id !== record.locationId;
  if (!timeChanged && !professionalChanged && !locationChanged) {
    throw invalid('startsAt', 'scheduling.reschedule.no_change');
  }

  const planInput: PlanInput = {
    professional,
    location,
    durationMinutes,
    bufferMinutes: record.bufferMinutes,
    startsAt,
    actor: input.actor,
    now: input.now,
    overrideHours: input.overrideHours,
    overrideHold: input.overrideHold,
    ignoreAppointmentId: record.id,
    checkPast: timeChanged,
    checkHours: true,
  };
  const plan = await planSlot(ports, planInput);
  await applyPlan(ports, plan);

  let updated: AppointmentDto;
  try {
    updated = await ports.updateAppointment(record.id, {
      startsAt: new Date(plan.range.start),
      endsAt: new Date(plan.range.end),
      professionalId: professional.id,
      locationId: location.id,
      lane: plan.lane,
      outOfHours: plan.outOfHours,
      overrideReason: plan.overrideReason,
      videoRoom: record.videoRoom ? randomUUID() : null,
    });
  } catch (error) {
    // The database refused an overlap that slipped through the checks (a race).
    if ((error as { cause?: { code?: string } }).cause?.code === '23P01') {
      throw await conflictAfterRace(ports, planInput, plan);
    }
    throw error;
  }

  await ports.insertEvent({
    appointmentId: record.id,
    kind: professionalChanged ? 'reassigned' : 'rescheduled',
    fromStatus: record.status,
    toStatus: record.status,
    actorUserId: input.actor.userId,
    actorKind: 'staff',
    details: {
      fromStartsAt: record.startsAt.toISOString(),
      fromEndsAt: record.endsAt.toISOString(),
      fromProfessionalId: record.professionalId,
      fromLocationId: record.locationId,
      ...(plan.overrides.length > 0 ? { overrides: plan.overrides } : {}),
    },
  });
  await ports.audit({
    action: professionalChanged ? 'appointment.reassigned' : 'appointment.rescheduled',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'appointment',
    resourceId: record.id,
    patientId: record.patientId,
    metadata: {
      fromStartsAt: record.startsAt.toISOString(),
      toStartsAt: updated.startsAt,
      fromProfessionalId: record.professionalId,
      toProfessionalId: professional.id,
    },
  });
  if (plan.overrides.length > 0) {
    await ports.audit({
      action: 'appointment.overridden',
      outcome: 'allow',
      actor: input.auditActor,
      resourceType: 'appointment',
      resourceId: record.id,
      patientId: record.patientId,
      metadata: {
        kinds: plan.overrides,
        ...(plan.overrideReason === null ? {} : { overrideReason: plan.overrideReason }),
      },
    });
  }
  return updated;
}

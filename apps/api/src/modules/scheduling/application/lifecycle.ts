import { randomUUID } from 'node:crypto';

import type {
  AppointmentDto,
  AppointmentStatus,
  CancelledBy,
  CancellationReason,
  CorrectionReason,
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
import { canConfirmIdentity, type IdentityConfirmation } from '../domain/identity-confirmation.js';

import { recordIdentityConfirmed } from './identity-records.js';
import {
  applyPlan,
  assertCalendar,
  assertLocation,
  guardRace,
  invalid,
  ownProfessionalOf,
  planSlot,
  resolveStart,
  typeOffered,
  type BookActor,
  type LocationAuthorizer,
  type Plan,
  type PlanInput,
} from './placement.js';
import type {
  AppointmentPatch,
  AppointmentRecord,
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

/** The statuses only the appointment's own professional puts an appointment in. */
const CLINICAL_STATUSES: ReadonlySet<AppointmentStatus> = new Set(['in_progress', 'attended']);

/**
 * Locks what a change to one appointment must serialize with: the professional(s) first, in a fixed
 * order so two moves cannot deadlock, then the appointment itself. Returns the locked row.
 */
export async function lockForChange(
  ports: SchedulingPorts,
  appointmentId: string,
  alsoProfessionalIds: readonly string[] = [],
  actor?: BookActor,
): Promise<AppointmentRecord> {
  const peek = await ports.findAppointment(appointmentId);
  if (!peek) throw new AppError('not_found');
  // The calendar and the location of the appointment are the actor's to work in, or it is refused
  // before anything is locked or changed.
  if (actor) {
    assertCalendar(actor, peek.professionalId);
    assertLocation(actor, peek.locationId, peek.professionalId);
  }
  const ids = [...new Set([peek.professionalId, ...alsoProfessionalIds])].sort();
  for (const id of ids) await ports.lockProfessional(id);
  const record = await ports.findAppointment(appointmentId, { lock: true });
  if (!record) throw new AppError('not_found');
  return record;
}

/**
 * Every write of an appointment names the version it was decided on. A version that is not the
 * current one is stale, and so is one that is missing: nothing changes on a guess.
 */
export function checkVersion(record: AppointmentRecord, expectedVersion: number): void {
  if (expectedVersion !== record.version) throw new AppError('stale_revision');
}

export interface TransitionInput {
  appointmentId: string;
  action: TransitionAction;
  actor: BookActor;
  auditActor: AuditActor & { userId: string };
  now: Date;
  expectedVersion: number;
  cancellation?: { cancelledBy: CancelledBy; reasonCode: CancellationReason; note?: string };
  /**
   * At check-in, the staff member saw the patient and the ID document and confirms who it is. Staff
   * other than the appointment's professional confirm; the professional's own check-in confirms
   * only in a solo practice (D18).
   */
  confirmIdentity?: boolean | undefined;
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
  const record = await lockForChange(ports, input.appointmentId, [], input.actor);
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
  let confirmation: IdentityConfirmation | null = null;
  if (input.action === 'check_in' && input.confirmIdentity === true && !record.identityConfirmed) {
    const own = ownProfessionalOf(input.actor) === record.professionalId;
    confirmation = canConfirmIdentity({
      actorProfessionalId: ownProfessionalOf(input.actor),
      appointmentProfessionalId: record.professionalId,
      channel: 'check_in',
      // The solo condition is evaluated here, in this transaction, only when it can matter.
      soloPractice: own ? await ports.soloPractice() : false,
    });
    if (confirmation) {
      Object.assign(patch, {
        identityConfirmed: true,
        identityConfirmedBy: input.actor.userId,
        identityConfirmation: confirmation,
      } satisfies AppointmentPatch);
    }
  }
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
  if (confirmation) {
    await recordIdentityConfirmed(ports, {
      record,
      how: confirmation,
      channel: 'check_in',
      actor: input.auditActor,
    });
  }
  if (input.action === 'cancel') await dismissWorklistItems(ports, record.id, input.auditActor);
  return updated;
}

/**
 * A cancelled appointment has nothing left for a person to decide: its open reception items (an
 * identity review, a pending approval) are dismissed, so the worklist never offers an action on it.
 * Closing an item that is not open does nothing.
 */
async function dismissWorklistItems(
  ports: SchedulingPorts,
  appointmentId: string,
  actor: AuditActor & { userId: string },
): Promise<void> {
  for (const kind of ['identity_review', 'pending_approval'] as const) {
    await ports.closeWorklistItem({
      kind,
      subjectType: 'appointment',
      subjectId: appointmentId,
      status: 'dismissed',
      resolution: 'appointment_cancelled',
      actor,
    });
  }
}

export interface CorrectInput {
  appointmentId: string;
  toStatus: AppointmentStatus;
  reasonCode: CorrectionReason;
  /** Free text for the history; it never goes to the audit trail. */
  note?: string | undefined;
  actor: BookActor;
  auditActor: AuditActor;
  now: Date;
  expectedVersion: number;
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
  const record = await lockForChange(ports, input.appointmentId, [], input.actor);
  checkVersion(record, input.expectedVersion);
  if (!canCorrect(record.status, input.toStatus)) throw new AppError('conflict');
  // Putting an appointment back into the clinical statuses is clinical work, like starting and
  // finishing it: only the professional of the appointment.
  if (
    CLINICAL_STATUSES.has(input.toStatus) &&
    input.actor.professionalId !== record.professionalId
  ) {
    throw new AccessRefused('not_the_appointment_professional');
  }

  const patch: AppointmentPatch = { status: input.toStatus };
  let updatePlan: { planInput: PlanInput; plan: Plan } | null = null;
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
    await applyPlan(ports, planInput, plan);
    patch.lane = plan.lane;
    updatePlan = { planInput, plan };
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

  const write = () => ports.updateAppointment(record.id, patch);
  const updated = updatePlan
    ? await guardRace(ports, updatePlan.planInput, updatePlan.plan, write)
    : await write();
  await ports.insertEvent({
    appointmentId: record.id,
    kind: 'status_corrected',
    fromStatus: record.status,
    toStatus: input.toStatus,
    actorUserId: input.actor.userId,
    actorKind: 'staff',
    details: { reasonCode: input.reasonCode, ...(input.note ? { note: input.note } : {}) },
  });
  await ports.audit({
    action: 'appointment.status_corrected',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'appointment',
    resourceId: record.id,
    patientId: record.patientId,
    metadata: { from: record.status, to: input.toStatus, reasonCode: input.reasonCode },
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
  authorizeLocation?: LocationAuthorizer;
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
    input.actor,
  );
  // Moving it into another calendar or location needs the right to work there too.
  assertCalendar(input.actor, input.professionalId ?? record.professionalId);
  if (input.locationId) {
    assertLocation(input.actor, input.locationId, input.professionalId ?? record.professionalId);
  }
  checkVersion(record, input.expectedVersion);
  if (!canReschedule(record.status)) throw new AppError('conflict');

  const professionalId = input.professionalId ?? record.professionalId;
  const professional: ProfessionalRecord | null = await ports.lockProfessional(professionalId);
  const location = await ports.findLocation(input.locationId ?? record.locationId);
  const type = await ports.findType(record.appointmentTypeId);
  if (!professional || !location || !type) throw new AppError('not_found');
  if (professional.status !== 'active' || !location.active) throw new AppError('conflict');
  if (input.authorizeLocation) await input.authorizeLocation(location, professional.id);

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
  await applyPlan(ports, planInput, plan);

  const updated = await guardRace(ports, planInput, plan, () =>
    ports.updateAppointment(record.id, {
      startsAt: new Date(plan.range.start),
      endsAt: new Date(plan.range.end),
      professionalId: professional.id,
      locationId: location.id,
      lane: plan.lane,
      outOfHours: plan.outOfHours,
      overrideReason: plan.overrideReason,
      videoRoom: record.videoRoom ? randomUUID() : null,
    }),
  );

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

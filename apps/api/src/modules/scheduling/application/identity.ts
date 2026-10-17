import type { AppointmentDto, CancelledBy, CancellationReason } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import { AppError } from '../../../platform/http/problem.js';
import { AccessRefused } from '../../access/index.js';
import { canConfirmIdentity } from '../domain/identity-confirmation.js';

import { publishPatientChange } from './events.js';
import { recordIdentityConfirmed } from './identity-records.js';
import { checkVersion, lockForChange, transitionAppointment } from './lifecycle.js';
import { invalid, type BookActor } from './placement.js';
import type { SchedulingPorts } from './ports.js';

type Actor = AuditActor & { userId: string };

export interface ConfirmIdentityInput {
  appointmentId: string;
  actor: BookActor;
  auditActor: Actor;
  expectedVersion: number;
}

/**
 * Confirms the identity of an appointment from its identity review on the worklist (D14). Anyone
 * but the appointment's own professional may; the professional never can from here, not even alone
 * in the organization: the solo exception (D18) exists only at in-person check-in.
 */
export async function confirmIdentity(
  ports: SchedulingPorts,
  input: ConfirmIdentityInput,
): Promise<AppointmentDto> {
  const record = await lockForChange(ports, input.appointmentId, [], input.actor);
  checkVersion(record, input.expectedVersion);
  // A cancelled appointment has no identity left to confirm.
  if (record.identityConfirmed || record.status === 'cancelled') throw new AppError('conflict');

  const how = canConfirmIdentity({
    actorProfessionalId: input.actor.professionalId,
    appointmentProfessionalId: record.professionalId,
    channel: 'worklist',
    soloPractice: false,
  });
  if (how === null) throw new AccessRefused('identity_confirm_own_appointment');

  const updated = await ports.updateAppointment(record.id, {
    identityConfirmed: true,
    identityConfirmedBy: input.actor.userId,
    identityConfirmation: how,
  });
  await recordIdentityConfirmed(ports, {
    record,
    how,
    channel: 'worklist',
    actor: input.auditActor,
  });
  return updated;
}

export type DetachResolution =
  | { kind: 'move_to_patient'; patientId: string }
  | {
      kind: 'cancel';
      cancellation: { cancelledBy: CancelledBy; reasonCode: CancellationReason; note?: string };
    };

export interface DetachInput {
  appointmentId: string;
  actor: BookActor;
  auditActor: Actor;
  now: Date;
  resolution: DetachResolution;
  expectedVersion: number;
}

/**
 * Rejects a match: staff find the appointment does not belong to the patient it was attached to.
 * They move it to a separate patient record, or cancel it. The matched record is not touched, and
 * the appointment's professional gains no care relationship with it. Only staff other than the
 * appointment's professional may do this.
 */
export async function detachPatient(
  ports: SchedulingPorts,
  input: DetachInput,
): Promise<AppointmentDto> {
  const record = await lockForChange(ports, input.appointmentId, [], input.actor);
  checkVersion(record, input.expectedVersion);
  if (record.identityConfirmed || record.status === 'cancelled') throw new AppError('conflict');
  if (input.actor.professionalId === record.professionalId) {
    throw new AccessRefused('identity_reject_own_appointment');
  }

  // The review is resolved as rejected before anything else closes it: cancelling the appointment
  // would otherwise dismiss it as an ordinary cancellation.
  await ports.closeWorklistItem({
    kind: 'identity_review',
    subjectType: 'appointment',
    subjectId: record.id,
    status: 'resolved',
    resolution: 'identity_rejected',
    actor: input.auditActor,
  });

  let result: AppointmentDto;
  if (input.resolution.kind === 'move_to_patient') {
    if (input.resolution.patientId === record.patientId) {
      throw invalid('patientId', 'scheduling.identity.same_patient');
    }
    const target = await ports.findPatient(input.resolution.patientId);
    if (!target) throw new AppError('not_found');
    if (target.status !== 'active') throw new AppError('conflict');
    // The staff member who separates the record has looked at who the patient is.
    result = await ports.updateAppointment(record.id, {
      patientId: target.id,
      identityConfirmed: true,
      identityConfirmedBy: input.actor.userId,
      identityConfirmation: 'staff',
    });
    await publishPatientChange(ports, { before: record, after: result });
  } else {
    result = await transitionAppointment(ports, {
      appointmentId: record.id,
      action: 'cancel',
      actor: input.actor,
      auditActor: input.auditActor,
      now: input.now,
      expectedVersion: record.version,
      cancellation: input.resolution.cancellation,
    });
  }

  await ports.insertEvent({
    appointmentId: record.id,
    kind: 'identity_rejected',
    actorUserId: input.actor.userId,
    actorKind: 'staff',
    details: { resolution: input.resolution.kind === 'move_to_patient' ? 'moved' : 'cancelled' },
  });
  await ports.audit({
    action: 'appointment.identity.rejected',
    outcome: 'allow',
    actor: input.auditActor,
    resourceType: 'appointment',
    resourceId: record.id,
    patientId: record.patientId,
    metadata: { resolution: input.resolution.kind === 'move_to_patient' ? 'moved' : 'cancelled' },
  });
  return result;
}

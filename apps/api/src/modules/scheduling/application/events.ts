import type { AppointmentDto, AppointmentStatus } from '@consultorio/contracts';

import type {
  AppointmentFacts,
  CancelledByKind,
  PreviousPlacement,
  SlotFreedCause,
} from '../../../platform/events/appointment-events.js';

import type { AppointmentRecord, SchedulingPorts } from './ports.js';

/**
 * What scheduling tells the appointment event bus (`platform/events`). One primary event per
 * action, plus `slot_freed` when time was given back. Everything runs inside the transaction of
 * the business write, so a subscriber that fails fails the write.
 */

export function factsOf(appointment: AppointmentDto): AppointmentFacts {
  return {
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    professionalId: appointment.professionalId,
    locationId: appointment.locationId,
    appointmentTypeId: appointment.appointmentTypeId,
    startsAt: new Date(appointment.startsAt),
    endsAt: new Date(appointment.endsAt),
    status: appointment.status,
    source: appointment.source,
    version: appointment.version,
  };
}

export function placementOf(record: AppointmentRecord): PreviousPlacement {
  return {
    professionalId: record.professionalId,
    locationId: record.locationId,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
  };
}

export async function publishCreated(
  ports: SchedulingPorts,
  appointment: AppointmentDto,
): Promise<void> {
  await ports.publishEvent({ kind: 'created', appointment: factsOf(appointment) });
}

/**
 * A step of the lifecycle. A cancellation is its own event and gives the time back; every other
 * change of status is a `status_changed`. A correction never frees a slot: it edits the history of
 * time that already passed.
 */
export async function publishStatusChange(
  ports: SchedulingPorts,
  input: {
    before: AppointmentRecord;
    after: AppointmentDto;
    cancelledBy?: CancelledByKind | null;
    correction?: boolean;
  },
): Promise<void> {
  const appointment = factsOf(input.after);
  const fromStatus: AppointmentStatus = input.before.status;
  if (input.after.status === 'cancelled' && input.correction !== true) {
    await ports.publishEvent({
      kind: 'cancelled',
      appointment,
      fromStatus,
      cancelledBy: input.cancelledBy ?? null,
    });
    await publishSlotFreed(ports, 'cancelled', placementOf(input.before), appointment);
    return;
  }
  await ports.publishEvent({ kind: 'status_changed', appointment, fromStatus });
}

/** A move to another time, place or professional: the old range becomes free. */
export async function publishMove(
  ports: SchedulingPorts,
  input: { before: AppointmentRecord; after: AppointmentDto },
): Promise<void> {
  const appointment = factsOf(input.after);
  const previous = placementOf(input.before);
  const reassigned = appointment.professionalId !== previous.professionalId;
  await ports.publishEvent({
    kind: reassigned ? 'reassigned' : 'rescheduled',
    appointment,
    previous,
  });
  await publishSlotFreed(ports, reassigned ? 'reassigned' : 'rescheduled', previous, appointment);
}

export async function publishPatientChange(
  ports: SchedulingPorts,
  input: { before: AppointmentRecord; after: AppointmentDto },
): Promise<void> {
  await ports.publishEvent({
    kind: 'patient_changed',
    appointment: factsOf(input.after),
    previousPatientId: input.before.patientId,
  });
}

async function publishSlotFreed(
  ports: SchedulingPorts,
  cause: SlotFreedCause,
  freed: PreviousPlacement,
  appointment: AppointmentFacts,
): Promise<void> {
  await ports.publishEvent({
    kind: 'slot_freed',
    cause,
    slot: {
      professionalId: freed.professionalId,
      locationId: freed.locationId,
      startsAt: freed.startsAt,
      endsAt: freed.endsAt,
    },
    appointment,
  });
}

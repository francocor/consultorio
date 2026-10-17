import { asc, eq } from 'drizzle-orm';

import { patient } from '../../../db/schema/patients.js';
import {
  appointmentType,
  professionalHoursException,
  scheduleBlock,
  tenantDayOff,
} from '../../../db/schema/scheduling-config.js';
import { appointment, appointmentEvent } from '../../../db/schema/scheduling.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * Administrative export part owned by scheduling: the appointment types, every appointment with
 * the history of its changes, blocks, days off and the special working-hours periods. Nothing here
 * is clinical content. The transient parts (slot holds, the occupancy index) are derived from the
 * appointments and are not exported, and neither is the reception worklist, an operational queue
 * whose details are encrypted.
 */
export const exportScheduling: ExportContributor = async ({ tx }) => {
  const types = await tx
    .select({
      id: appointmentType.id,
      name: appointmentType.name,
      description: appointmentType.description,
      durationMinutes: appointmentType.durationMinutes,
      bufferMinutes: appointmentType.bufferMinutes,
      mode: appointmentType.mode,
      requiresApproval: appointmentType.requiresApproval,
      active: appointmentType.active,
    })
    .from(appointmentType)
    .orderBy(asc(appointmentType.createdAt), asc(appointmentType.id));

  const appointments = await tx
    .select({
      id: appointment.id,
      patientId: appointment.patientId,
      patientFamilyName: patient.familyName,
      patientGivenNames: patient.givenNames,
      professionalId: appointment.professionalId,
      locationId: appointment.locationId,
      appointmentTypeId: appointment.appointmentTypeId,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      source: appointment.source,
      outOfHours: appointment.outOfHours,
      overrideReason: appointment.overrideReason,
      identityConfirmed: appointment.identityConfirmed,
      seriesId: appointment.seriesId,
      cancelledByKind: appointment.cancelledByKind,
      cancelReason: appointment.cancelReason,
      cancelNote: appointment.cancelNote,
      cancelledAt: appointment.cancelledAt,
      lateCancellation: appointment.lateCancellation,
      bookedAt: appointment.createdAt,
    })
    .from(appointment)
    .innerJoin(patient, eq(patient.id, appointment.patientId))
    .orderBy(asc(appointment.startsAt), asc(appointment.id));

  const events = await tx
    .select({
      appointmentId: appointmentEvent.appointmentId,
      kind: appointmentEvent.kind,
      fromStatus: appointmentEvent.fromStatus,
      toStatus: appointmentEvent.toStatus,
      actorKind: appointmentEvent.actorKind,
      details: appointmentEvent.details,
      at: appointmentEvent.createdAt,
    })
    .from(appointmentEvent)
    .orderBy(asc(appointmentEvent.createdAt), asc(appointmentEvent.id));

  const blocks = await tx
    .select({
      professionalId: scheduleBlock.professionalId,
      locationId: scheduleBlock.locationId,
      startsAt: scheduleBlock.startsAt,
      endsAt: scheduleBlock.endsAt,
      reason: scheduleBlock.reason,
      removedAt: scheduleBlock.removedAt,
    })
    .from(scheduleBlock)
    .orderBy(asc(scheduleBlock.startsAt), asc(scheduleBlock.id));

  const daysOff = await tx
    .select({
      day: tenantDayOff.day,
      name: tenantDayOff.name,
      locationId: tenantDayOff.locationId,
      removedAt: tenantDayOff.removedAt,
    })
    .from(tenantDayOff)
    .orderBy(asc(tenantDayOff.day), asc(tenantDayOff.id));

  const hoursPeriods = await tx
    .select({
      professionalId: professionalHoursException.professionalId,
      periodId: professionalHoursException.periodId,
      dateFrom: professionalHoursException.dateFrom,
      dateTo: professionalHoursException.dateTo,
      reason: professionalHoursException.reason,
      locationId: professionalHoursException.locationId,
      weekday: professionalHoursException.weekday,
      startMinute: professionalHoursException.startMinute,
      endMinute: professionalHoursException.endMinute,
      removedAt: professionalHoursException.removedAt,
    })
    .from(professionalHoursException)
    .orderBy(asc(professionalHoursException.dateFrom), asc(professionalHoursException.id));

  return {
    appointmentTypes: types,
    appointments,
    appointmentEvents: events,
    blocks,
    daysOff,
    hoursPeriods,
  };
};

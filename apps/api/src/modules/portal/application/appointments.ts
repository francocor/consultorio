import {
  DEFAULT_ONLINE_BOOKING_SETTINGS,
  OnlineBookingSettings,
  type AppointmentStatus,
  type PortalAppointmentDto,
  type PortalAppointmentsResponse,
} from '@consultorio/contracts';

import { tenant } from '../../../db/schema/tenant.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import type { TenantKeys } from '../../../platform/crypto/tenant-keys.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import type { AppointmentEvents } from '../../../platform/events/appointment-events.js';
import { AppError } from '../../../platform/http/problem.js';
import type { VideoJoinRegistry } from '../../notifications/index.js';
import {
  createSchedulingPorts,
  findPatientAppointment,
  listPatientAppointments,
  transitionAppointment,
  type BookActor,
  type PatientAppointmentView,
} from '../../scheduling/index.js';
import { cancelDeadline, canCancel, canConfirm } from '../domain/appointment-policy.js';

import type { PortalSubject } from './subject.js';

export interface AppointmentDeps {
  keys: TenantKeys;
  events: AppointmentEvents | undefined;
  /** The address of a video appointment, from teleconsultation through notifications' registry. */
  videoJoin: VideoJoinRegistry['resolver'] | undefined;
  clock: () => Date;
}

/** The patient acts through the system: the history and the trail say it was the patient. */
const ON_BEHALF_OF_PATIENT: BookActor = {
  userId: SYSTEM_USER_ID,
  permissions: new Set<string>(),
  professionalId: null,
};

/** The hours before the start until which a patient may cancel (`onlineBooking.rescheduleDeadlineHours`). */
async function cancelDeadlineHours(tx: Tx): Promise<number> {
  const [row] = await tx.select({ settings: tenant.settings }).from(tenant);
  const stored = row?.settings['onlineBooking'];
  const merged = OnlineBookingSettings.safeParse({
    ...DEFAULT_ONLINE_BOOKING_SETTINGS,
    ...(typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {}),
  });
  return (merged.success ? merged.data : DEFAULT_ONLINE_BOOKING_SETTINGS).rescheduleDeadlineHours;
}

async function toDto(
  tx: Tx,
  deps: AppointmentDeps,
  view: PatientAppointmentView,
  hours: number,
): Promise<PortalAppointmentDto> {
  const now = deps.clock();
  const upcoming = view.endsAt.getTime() > now.getTime();
  const state = { status: view.status, startsAt: view.startsAt, now, deadlineHours: hours };
  let joinUrl: string | null = null;
  let joinPending = false;
  if (view.mode === 'virtual' && upcoming && view.status !== 'cancelled') {
    const join = (await deps.videoJoin?.resolve(tx, view.id)) ?? { kind: 'pending' as const };
    if (join.kind === 'link') joinUrl = join.url;
    if (join.kind === 'pending') joinPending = true;
  }
  return {
    id: view.id,
    startsAt: view.startsAt.toISOString(),
    endsAt: view.endsAt.toISOString(),
    timeZone: view.timeZone,
    status: view.status,
    professionalName: view.professionalName,
    locationName: view.locationName,
    typeName: view.typeName,
    mode: view.mode,
    canConfirm: canConfirm(state),
    canCancel: canCancel(state),
    cancelDeadline: upcoming ? cancelDeadline(view.startsAt, hours).toISOString() : null,
    joinUrl,
    joinPending,
  };
}

/** The upcoming and the past appointments of the subject (spec "Appointments in the portal"). */
export async function readAppointments(
  tx: Tx,
  deps: AppointmentDeps,
  subject: PortalSubject,
): Promise<PortalAppointmentsResponse> {
  const { upcoming, past } = await listPatientAppointments(tx, {
    patientId: subject.patientId,
    now: deps.clock(),
  });
  const hours = await cancelDeadlineHours(tx);
  return {
    upcoming: await Promise.all(upcoming.map((view) => toDto(tx, deps, view, hours))),
    past: await Promise.all(past.map((view) => toDto(tx, deps, view, hours))),
  };
}

export type AppointmentChange =
  | { ok: true; appointment: PortalAppointmentDto }
  /** No such appointment for this subject (or none at all): the caller answers 404 and records it. */
  | { ok: false; reason: 'not_found' };

async function change(
  tx: Tx,
  deps: AppointmentDeps,
  subject: PortalSubject,
  input: { appointmentId: string; action: 'confirm' | 'cancel'; actor: AuditActor },
): Promise<AppointmentChange> {
  const view = await findPatientAppointment(tx, {
    appointmentId: input.appointmentId,
    patientId: subject.patientId,
  });
  if (!view) return { ok: false, reason: 'not_found' };

  const now = deps.clock();
  const hours = await cancelDeadlineHours(tx);
  const state = { status: view.status, startsAt: view.startsAt, now, deadlineHours: hours };
  if (input.action === 'confirm' && !canConfirm(state)) {
    throw new AppError('portal_appointment_unavailable');
  }
  if (input.action === 'cancel') {
    const cancellable: ReadonlySet<AppointmentStatus> = new Set([
      'pending_approval',
      'scheduled',
      'confirmed',
    ]);
    if (!cancellable.has(view.status) || view.startsAt.getTime() <= now.getTime()) {
      throw new AppError('portal_appointment_unavailable');
    }
    // The policy of the organization, enforced here and not on the screen.
    if (!canCancel(state)) throw new AppError('portal_cancel_deadline_passed');
  }

  try {
    // A savepoint: a change that something refuses half way leaves nothing behind.
    await tx.transaction((inner) =>
      transitionAppointment(
        createSchedulingPorts(inner, {
          keys: deps.keys,
          ...(deps.events ? { events: deps.events } : {}),
        }),
        {
          appointmentId: view.id,
          action: input.action,
          actor: ON_BEHALF_OF_PATIENT,
          auditActor: { ...input.actor, userId: SYSTEM_USER_ID },
          now,
          expectedVersion: view.version,
          actorKind: 'patient',
          ...(input.action === 'cancel'
            ? { cancellation: { cancelledBy: 'patient', reasonCode: 'patient_request' } as const }
            : {}),
        },
      ),
    );
  } catch (error) {
    // The state machine said no (it moved in the meantime).
    if (error instanceof AppError) throw new AppError('portal_appointment_unavailable');
    throw error;
  }
  const after = await findPatientAppointment(tx, {
    appointmentId: view.id,
    patientId: subject.patientId,
  });
  if (!after) return { ok: false, reason: 'not_found' };
  return { ok: true, appointment: await toDto(tx, deps, after, hours) };
}

export const confirmAppointment = (
  tx: Tx,
  deps: AppointmentDeps,
  subject: PortalSubject,
  input: { appointmentId: string; actor: AuditActor },
) => change(tx, deps, subject, { ...input, action: 'confirm' });

export const cancelAppointment = (
  tx: Tx,
  deps: AppointmentDeps,
  subject: PortalSubject,
  input: { appointmentId: string; actor: AuditActor },
) => change(tx, deps, subject, { ...input, action: 'cancel' });

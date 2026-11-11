import type {
  AppointmentStatus,
  PublicAvailabilityResponse,
  PublicConfirmationDto,
  PublicManageDto,
  PublicManageSlotsQuery,
} from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { bookingSubmission } from '../../../db/schema/booking-submission.js';
import { membership } from '../../../db/schema/identity.js';
import { appointmentType } from '../../../db/schema/scheduling-config.js';
import { professional } from '../../../db/schema/staff.js';
import { location } from '../../../db/schema/tenant.js';
import type { AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import type { ActionTokens } from '../../../platform/tokens/index.js';
import {
  rescheduleAppointment,
  SlotNoLongerAvailableError,
  SlotTakenError,
  transitionAppointment,
} from '../../scheduling/index.js';
import type { SchedulingPorts } from '../../scheduling/index.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { dailyCapReached, filterBookableSlots, localDateOf } from '../domain/booking-rules.js';

import type { BookingNotice } from './booking-notifier.js';
import { readBookingSettings } from './booking-settings.js';
import { renderIcs } from './ics.js';
import { publicAvailability } from './public-availability.js';
import { onlineBookingsOnDay, PUBLIC_ACTOR } from './public-holds.js';
import { findOfferByProfessional, type OfferContext } from './public-offer.js';
import { publicCapacityPorts } from './public-ports.js';

/** The statuses in which a patient can still change or cancel by link. */
const CHANGEABLE: ReadonlySet<AppointmentStatus> = new Set([
  'pending_approval',
  'scheduled',
  'confirmed',
]);

export interface ManageDeps {
  tokens: ActionTokens;
  portsOf: (tx: Tx) => SchedulingPorts;
}

export interface ManageContext {
  tenant: { id: string; slug: string; isDemo: boolean };
  now: Date;
  actor: AuditActor;
  offerContext: OfferContext;
}

/** What a link is about: the appointment and the names the page shows. */
interface Managed {
  appointmentId: string;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  professionalId: string;
  professionalName: string;
  locationId: string;
  locationName: string;
  timeZone: string;
  typeId: string;
  typeName: string;
  mode: 'in_person' | 'virtual';
  patientId: string;
  version: number;
  /** Where the appointment came from: only an online one counts against the cap of online bookings. */
  source: string;
}

async function describeAppointment(
  tx: Tx,
  ports: SchedulingPorts,
  appointmentId: string,
): Promise<Managed | null> {
  const record = await ports.findAppointment(appointmentId);
  if (!record) return null;
  const [who] = await tx
    .select({ name: membership.displayName })
    .from(professional)
    .innerJoin(membership, eq(membership.id, professional.membershipId))
    .where(eq(professional.id, record.professionalId));
  const [place] = await tx
    .select({ name: location.name, timeZone: location.timeZone })
    .from(location)
    .where(eq(location.id, record.locationId));
  const [type] = await tx
    .select({ name: appointmentType.name, mode: appointmentType.mode })
    .from(appointmentType)
    .where(eq(appointmentType.id, record.appointmentTypeId));
  if (!place || !type) return null;
  return {
    appointmentId: record.id,
    status: record.status,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    professionalId: record.professionalId,
    professionalName: who?.name?.trim() || 'Profesional',
    locationId: record.locationId,
    locationName: place.name,
    timeZone: place.timeZone,
    typeId: record.appointmentTypeId,
    typeName: type.name,
    mode: type.mode === 'virtual' ? 'virtual' : 'in_person',
    patientId: record.patientId,
    version: record.version,
    source: record.source,
  };
}

const publicStatus = (status: AppointmentStatus): PublicManageDto['appointment']['status'] =>
  status === 'scheduled' || status === 'pending_approval' || status === 'cancelled'
    ? status
    : 'confirmed';

function deadlineOf(startsAt: Date, rescheduleDeadlineHours: number): Date {
  return new Date(startsAt.getTime() - rescheduleDeadlineHours * 3_600_000);
}

/** What the link shows: the appointment's date, place and professional, and whether it can change. */
export async function viewManaged(
  tx: Tx,
  deps: ManageDeps,
  input: { token: string; context: ManageContext },
): Promise<PublicManageDto | null> {
  const found = await deps.tokens.inspect(tx, 'appointment_reschedule', input.token);
  if (!found) return null;
  const managed = await describeAppointment(tx, deps.portsOf(tx), found.subjectId);
  if (!managed) return null;
  const settings = await readBookingSettings(tx);
  const deadline = deadlineOf(managed.startsAt, settings.booking.rescheduleDeadlineHours);
  return {
    appointment: {
      status: publicStatus(managed.status),
      startsAt: managed.startsAt.toISOString(),
      endsAt: managed.endsAt.toISOString(),
      timeZone: managed.timeZone,
      professionalName: settings.hideProfessional ? null : managed.professionalName,
      locationName: managed.locationName,
      typeName: settings.hideAppointmentType ? null : managed.typeName,
      mode: managed.mode,
    },
    organizationName: await readOrganizationName(tx),
    canChange: CHANGEABLE.has(managed.status) && input.context.now.getTime() < deadline.getTime(),
    changeDeadline: deadline.toISOString(),
  };
}

/** The free slots to move to: same professional, type and location, under the rules of a booking. */
export async function managedSlots(
  tx: Tx,
  deps: ManageDeps,
  input: { token: string; query: PublicManageSlotsQuery; context: ManageContext },
): Promise<PublicAvailabilityResponse | null> {
  const found = await deps.tokens.inspect(tx, 'appointment_reschedule', input.token);
  if (!found) return null;
  const ports = deps.portsOf(tx);
  const managed = await describeAppointment(tx, ports, found.subjectId);
  if (!managed || !CHANGEABLE.has(managed.status)) return null;
  const settings = await readBookingSettings(tx);
  const offer = await findOfferByProfessional(
    tx,
    { professionalId: managed.professionalId },
    input.context.offerContext,
  );
  if (!offer) return { slots: [], nextAvailable: null };
  try {
    return await publicAvailability(tx, {
      offer,
      query: {
        typeId: managed.typeId,
        locationId: managed.locationId,
        from: input.query.from,
        to: input.query.to,
      },
      settings: settings.booking,
      now: input.context.now,
      ports,
    });
  } catch (error) {
    if (error instanceof AppError) return { slots: [], nextAvailable: null };
    throw error;
  }
}

export type ChangeOutcome =
  /** `notice` is null when no verified address is known to tell. */
  | { ok: true; confirmation: PublicConfirmationDto; notice: BookingNotice | null }
  | { ok: false; refusal: 'not_found' };

/**
 * Moves the appointment to another time with the rules of a new booking (online-booking,
 * "Self-service change and cancellation"): the same professional, type and place, inside the lead
 * time and the horizon, under the daily cap and with room for one. The old time is released only
 * when the new one is confirmed, in the same transaction; if the move fails the appointment, and the
 * link, stay as they were. The old link dies and a new one is issued for the new time.
 */
export async function rescheduleManaged(
  tx: Tx,
  deps: ManageDeps,
  input: { token: string; startsAt: string; context: ManageContext },
): Promise<ChangeOutcome> {
  const { context } = input;
  const redeemed = await deps.tokens.redeem(tx, 'appointment_reschedule', input.token);
  if (!redeemed) return { ok: false, refusal: 'not_found' };
  const ports = deps.portsOf(tx);
  const peek = await describeAppointment(tx, ports, redeemed.subjectId);
  if (!peek) return { ok: false, refusal: 'not_found' };

  const settings = await readBookingSettings(tx);
  const deadline = deadlineOf(peek.startsAt, settings.booking.rescheduleDeadlineHours);
  if (!CHANGEABLE.has(peek.status)) return { ok: false, refusal: 'not_found' };
  if (context.now.getTime() >= deadline.getTime())
    throw new AppError('booking_change_deadline_passed');

  const offer = await findOfferByProfessional(
    tx,
    { professionalId: peek.professionalId },
    context.offerContext,
  );
  const type = offer?.types.find((candidate) => candidate.id === peek.typeId);
  const place = offer?.locations.find((candidate) => candidate.id === peek.locationId);
  if (!offer || !type || !place) throw new SlotNoLongerAvailableError();

  // The rules of a booking: lead time, horizon and the day's cap (this appointment does not count).
  if (
    filterBookableSlots([{ startsAt: input.startsAt }], {
      now: context.now,
      minLeadHours: settings.booking.minLeadHours,
      horizonDays: settings.booking.horizonDays,
    }).length === 0
  ) {
    throw new SlotNoLongerAvailableError();
  }
  const target = new Date(input.startsAt);
  // Room for one, whatever the professional allows internally: the public never uses an
  // overbooked lane. Taken under the professional's lock, so nothing slips in before the move, and
  // before the day's cap is read, so two moves into the same day are served one after the other.
  await ports.lockProfessional(peek.professionalId);
  const booked = await onlineBookingsOnDay(tx, {
    professionalId: peek.professionalId,
    startsAt: target,
    timeZone: place.timeZone,
  });
  // The cap counts days of the place, not of Greenwich. The appointment being moved is one of the
  // bookings of its own day (when it is an online one), so it does not count against the day it
  // stays in.
  const staysInDay =
    peek.source === 'online' &&
    localDateOf(place.timeZone, peek.startsAt) === localDateOf(place.timeZone, target);
  if (dailyCapReached(settings.booking.dailyCap, staysInDay ? booked - 1 : booked)) {
    throw new SlotNoLongerAvailableError();
  }
  const end = target.getTime() + (peek.endsAt.getTime() - peek.startsAt.getTime());
  const occupied = await publicCapacityPorts(ports).occupancies(peek.professionalId, {
    start: target.getTime(),
    end: end + (await bufferOf(tx, peek.typeId)) * 60_000,
  });
  if (occupied.some((other) => other.id !== peek.appointmentId)) {
    throw new SlotTakenError({ start: target.getTime(), end }, []);
  }

  let moved;
  try {
    moved = await rescheduleAppointment(ports, {
      appointmentId: peek.appointmentId,
      expectedVersion: peek.version,
      startsAt: input.startsAt,
      actor: PUBLIC_ACTOR,
      auditActor: { ...context.actor, userId: null },
      now: context.now,
      actorKind: 'patient',
    });
  } catch (error) {
    // Outside working hours, in a block or on a holiday: simply not available.
    if (error instanceof AppError && error.code === 'validation_failed') {
      throw new SlotNoLongerAvailableError();
    }
    throw error;
  }

  await deps.tokens.revokeForSubject(tx, 'appointment_reschedule', peek.appointmentId);
  const issued = await deps.tokens.issue(tx, {
    kind: 'appointment_reschedule',
    subjectId: peek.appointmentId,
    ttlMs: Math.max(1, new Date(moved.startsAt).getTime() - context.now.getTime()),
  });
  const organizationName = await readOrganizationName(tx);
  const pending = moved.status === 'pending_approval';
  const verifiedEmail = await verifiedEmailOf(tx, peek.appointmentId);
  return {
    ok: true,
    confirmation: {
      status: pending ? 'pending_approval' : 'scheduled',
      startsAt: moved.startsAt,
      endsAt: moved.endsAt,
      timeZone: place.timeZone,
      organizationName,
      professionalName: peek.professionalName,
      locationName: peek.locationName,
      typeName: peek.typeName,
      mode: type.mode,
      calendarFile: renderIcs({
        uid: peek.appointmentId,
        organizationName,
        professionalName: peek.professionalName,
        locationName: peek.locationName,
        startsAt: new Date(moved.startsAt),
        endsAt: new Date(moved.endsAt),
        confirmed: !pending,
        now: context.now,
      }),
      managePath: `/book/manage/${issued.token}`,
    },
    // The address the patient verified when they booked, not the one on the record.
    notice:
      verifiedEmail === null
        ? null
        : {
            tenant: context.tenant,
            to: verifiedEmail,
            organizationName,
            professionalName: peek.professionalName,
            locationName: peek.locationName,
            startsAt: new Date(moved.startsAt),
            timeZone: place.timeZone,
            pendingApproval: pending,
            manageToken: issued.token,
            whatsappOptInToken: null,
            patientId: peek.patientId,
            appointmentId: peek.appointmentId,
          },
  };
}

/** The address the patient verified with a code when this appointment was booked online. */
async function verifiedEmailOf(tx: Tx, appointmentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ email: bookingSubmission.email })
    .from(bookingSubmission)
    .where(eq(bookingSubmission.appointmentId, appointmentId));
  return row?.email ?? null;
}

/** The buffer after the type of visit, in minutes. */
async function bufferOf(tx: Tx, typeId: string): Promise<number> {
  const [row] = await tx
    .select({ buffer: appointmentType.bufferMinutes })
    .from(appointmentType)
    .where(eq(appointmentType.id, typeId));
  return row?.buffer ?? 0;
}

/**
 * Cancels the appointment on behalf of the patient (cancelled by the patient, with the
 * organization's late-cancellation rule). The slot is given back through scheduling, which tells the
 * waitlist. It works in a read-only organization: it protects the patient.
 */
export async function cancelManaged(
  tx: Tx,
  deps: ManageDeps,
  input: { token: string; context: ManageContext },
): Promise<PublicManageDto | null> {
  const { context } = input;
  const redeemed = await deps.tokens.redeem(tx, 'appointment_reschedule', input.token);
  if (!redeemed) return null;
  const ports = deps.portsOf(tx);
  const peek = await describeAppointment(tx, ports, redeemed.subjectId);
  if (!peek || !CHANGEABLE.has(peek.status)) return null;
  const settings = await readBookingSettings(tx);
  const deadline = deadlineOf(peek.startsAt, settings.booking.rescheduleDeadlineHours);
  if (context.now.getTime() >= deadline.getTime())
    throw new AppError('booking_change_deadline_passed');

  await transitionAppointment(ports, {
    appointmentId: peek.appointmentId,
    action: 'cancel',
    actor: PUBLIC_ACTOR,
    auditActor: { ...context.actor, userId: SYSTEM_USER_ID },
    now: context.now,
    expectedVersion: peek.version,
    cancellation: { cancelledBy: 'patient', reasonCode: 'patient_request' },
    actorKind: 'patient',
  });
  return {
    appointment: {
      status: 'cancelled',
      startsAt: peek.startsAt.toISOString(),
      endsAt: peek.endsAt.toISOString(),
      timeZone: peek.timeZone,
      professionalName: settings.hideProfessional ? null : peek.professionalName,
      locationName: peek.locationName,
      typeName: settings.hideAppointmentType ? null : peek.typeName,
      mode: peek.mode,
    },
    organizationName: await readOrganizationName(tx),
    canChange: false,
    changeDeadline: deadline.toISOString(),
  };
}

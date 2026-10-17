import { randomUUID } from 'node:crypto';

import type { AppointmentDto } from '@consultorio/contracts';

import type { AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';
import { AppError } from '../../../platform/http/problem.js';
import {
  bookAppointment,
  SlotNoLongerAvailableError,
  SlotTakenError,
  type BookActor,
  type SchedulingPorts,
} from '../../scheduling/index.js';

/** Nobody signed in: the rules of a booking apply with no override of any kind. */
const BOOKER: BookActor = { userId: SYSTEM_USER_ID, permissions: new Set(), professionalId: null };

export interface SlotBookingInput {
  patientId: string;
  professionalId: string;
  locationId: string;
  appointmentTypeId: string;
  startsAt: Date;
  /** False when a public self-join attached the entry to a patient who already existed (D14). */
  identityConfirmed: boolean;
  auditActor: AuditActor;
  now: Date;
}

export type SlotBooking =
  | { ok: true; appointment: AppointmentDto }
  /** Somebody else holds the time (an appointment, a hold, the professional's other place). */
  | { ok: false; reason: 'slot_taken' }
  /** The slot is no longer a bookable one: a block, a day off, hours that changed, an inactive type. */
  | { ok: false; reason: 'slot_unavailable' };

/**
 * The scheduling ports as a waitlist booking sees them. A booking from an offer is a public flow:
 * it takes capacity ONE whatever the professional allows (the professional reads as a single-lane
 * one and every occupancy as lane 1), the appointment's source is `waitlist_offer`, nobody is
 * recorded as the booker, and the patient's identity starts unconfirmed when the entry was attached
 * to an existing record (D14). In a dry run nothing is written at all: every check runs and the
 * answer says whether the booking would have gone through.
 */
function waitlistPorts(
  ports: SchedulingPorts,
  options: { dryRun: boolean; identityConfirmed: boolean },
): SchedulingPorts {
  const single = <T extends { maxSimultaneous: number }>(record: T | null) =>
    record ? { ...record, maxSimultaneous: 1 } : null;
  const silent = options.dryRun;

  return {
    ...ports,
    lockProfessional: async (id) => single(await ports.lockProfessional(id)),
    findProfessional: async (id) => single(await ports.findProfessional(id)),
    occupancies: async (professionalId, range) =>
      (await ports.occupancies(professionalId, range)).map((occupancy) => ({
        ...occupancy,
        lane: 1,
      })),
    isFreshPatient: () => Promise.resolve(false),
    async insertAppointment(values) {
      if (silent) {
        return {
          ok: true,
          appointment: {
            id: randomUUID(),
            patientId: values.patientId,
            professionalId: values.professionalId,
            locationId: values.locationId,
            appointmentTypeId: values.appointmentTypeId,
            startsAt: values.startsAt.toISOString(),
            endsAt: values.endsAt.toISOString(),
            bufferMinutes: values.bufferMinutes,
            status: 'scheduled',
            source: 'waitlist_offer',
            bookedBy: null,
            identityConfirmed: options.identityConfirmed,
            identityConfirmation: null,
            outOfHours: false,
            seriesId: null,
            seriesIndex: null,
            version: 1,
          },
        };
      }
      const inserted = await ports.insertAppointment({
        ...values,
        source: 'waitlist_offer',
        bookedBy: null,
        identityConfirmed: options.identityConfirmed,
      });
      if (inserted.ok && !options.identityConfirmed) {
        await ports.openWorklistItem({
          kind: 'identity_review',
          subjectType: 'appointment',
          subjectId: inserted.appointment.id,
          locationId: values.locationId,
        });
      }
      return inserted;
    },
    openWorklistItem: (item) => (silent ? Promise.resolve() : ports.openWorklistItem(item)),
    insertEvent: (event) =>
      silent
        ? Promise.resolve()
        : ports.insertEvent({
            ...event,
            actorUserId: null,
            actorKind: 'patient',
            details: { ...event.details, source: 'waitlist_offer' },
          }),
    publishEvent: (event) => (silent ? Promise.resolve() : ports.publishEvent(event)),
    audit: (event) =>
      silent
        ? Promise.resolve()
        : ports.audit(
            event.action === 'appointment.created'
              ? {
                  ...event,
                  metadata: {
                    ...event.metadata,
                    identityConfirmed: options.identityConfirmed,
                    source: 'waitlist_offer',
                  },
                }
              : event,
          ),
    updateHold: (id, patch) => (silent ? Promise.resolve() : ports.updateHold(id, patch)),
    invalidateHolds: (ids) => (silent ? Promise.resolve() : ports.invalidateHolds(ids)),
    applyLaneMoves: (moves) => (silent ? Promise.resolve() : ports.applyLaneMoves(moves)),
  };
}

async function attempt(
  ports: SchedulingPorts,
  input: SlotBookingInput,
  dryRun: boolean,
): Promise<SlotBooking> {
  try {
    const appointment = await bookAppointment(
      waitlistPorts(ports, { dryRun, identityConfirmed: input.identityConfirmed }),
      {
        request: {
          patientId: input.patientId,
          professionalId: input.professionalId,
          locationId: input.locationId,
          appointmentTypeId: input.appointmentTypeId,
          startsAt: input.startsAt.toISOString(),
        },
        actor: BOOKER,
        auditActor: input.auditActor,
        now: input.now,
      },
    );
    return { ok: true, appointment };
  } catch (error) {
    if (error instanceof SlotTakenError || error instanceof SlotNoLongerAvailableError) {
      return { ok: false, reason: 'slot_taken' };
    }
    // The patient, the type, the professional or the place cannot be booked any more, or the slot
    // broke a rule (hours, block, holiday, the past).
    if (error instanceof AppError) return { ok: false, reason: 'slot_unavailable' };
    throw error;
  }
}

/**
 * Whether this booking would go through now, through every rule scheduling applies to a booking
 * (hours, blocks, holidays, the past, who offers what, capacity one). Writes nothing.
 */
export function canBookSlot(ports: SchedulingPorts, input: SlotBookingInput): Promise<SlotBooking> {
  return attempt(ports, input, true);
}

/**
 * Books the slot for the patient through scheduling's `bookAppointment`, with the rules of a
 * public flow described above. The caller holds the transaction; when the answer is not `ok` the
 * booking wrote nothing.
 */
export function bookSlot(ports: SchedulingPorts, input: SlotBookingInput): Promise<SlotBooking> {
  return attempt(ports, input, false);
}

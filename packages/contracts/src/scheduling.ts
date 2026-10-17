import { z } from 'zod';

/**
 * Contracts of scheduling: appointments, booking, the attendance lifecycle, the reception
 * worklist, availability and series. The tenant and the person who acts are never fields: both
 * come from the session. A booking request is deliberately NOT strict: a client that sends its own
 * `createdBy` or `tenantId` has those values ignored, not rejected (scheduling, "Client cannot set
 * identity").
 */

/** The eight appointment statuses, and no others ("rescheduled" is derived from history). */
export const APPOINTMENT_STATUSES = [
  'pending_approval',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'attended',
  'no_show',
  'cancelled',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export function isAppointmentStatus(value: string): value is AppointmentStatus {
  return APPOINTMENT_STATUSES.some((status) => status === value);
}

export const APPOINTMENT_SOURCES = ['staff', 'online', 'waitlist_offer'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

const Instant = z.iso.datetime({ offset: true });

/** A wall-clock time at the location of the appointment. */
export const LocalStart = z.strictObject({
  date: z.iso.date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
  /** Which of two equal wall-clock times is meant when clocks go back. */
  occurrence: z.enum(['first', 'second']).optional(),
});
export type LocalStart = z.infer<typeof LocalStart>;

/** Booking outside working hours, over a block or on a holiday needs a reason (audited). */
export const OverrideHours = z.strictObject({ reason: z.string().trim().min(1).max(200) });
export type OverrideHours = z.infer<typeof OverrideHours>;

export const BookAppointmentRequest = z
  .object({
    patientId: z.uuid(),
    professionalId: z.uuid(),
    locationId: z.uuid(),
    appointmentTypeId: z.uuid(),
    /** The instant, with an offset. Exactly one of `startsAt` and `local`. */
    startsAt: Instant.optional(),
    /** The local time at the location (the server reads it in the location's zone). */
    local: LocalStart.optional(),
    overrideHours: OverrideHours.optional(),
    /** Book over an active slot hold, invalidating it. */
    overrideHold: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.startsAt === undefined) === (value.local === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['startsAt'],
        message: 'give either an instant or a local time',
      });
    }
  });
export type BookAppointmentRequest = z.infer<typeof BookAppointmentRequest>;

export const AppointmentDto = z.strictObject({
  id: z.uuid(),
  patientId: z.uuid(),
  professionalId: z.uuid(),
  locationId: z.uuid(),
  appointmentTypeId: z.uuid(),
  startsAt: Instant,
  endsAt: Instant,
  bufferMinutes: z.number().int(),
  status: z.enum(APPOINTMENT_STATUSES),
  source: z.enum(APPOINTMENT_SOURCES),
  bookedBy: z.uuid().nullable(),
  identityConfirmed: z.boolean(),
  outOfHours: z.boolean(),
  seriesId: z.uuid().nullable(),
  seriesIndex: z.number().int().nullable(),
  version: z.number().int(),
});
export type AppointmentDto = z.infer<typeof AppointmentDto>;

/** A free time the conflict answer offers instead. */
export const SlotRange = z.strictObject({ startsAt: Instant, endsAt: Instant });
export type SlotRange = z.infer<typeof SlotRange>;

/**
 * The extra members of a `409 slot_taken`: the time that is taken (no patient, no clinical data)
 * and the next free times for the same professional.
 */
export const SlotConflictExtension = z.strictObject({
  conflict: SlotRange,
  nextSlots: z.array(SlotRange).max(10),
});
export type SlotConflictExtension = z.infer<typeof SlotConflictExtension>;

// Lifecycle -----------------------------------------------------------------------------------

const ExpectedVersion = z.number().int().min(1);

/** Optimistic concurrency: a stale `expectedVersion` gets 409 `stale_revision`. */
export const TransitionRequest = z.strictObject({ expectedVersion: ExpectedVersion.optional() });
export type TransitionRequest = z.infer<typeof TransitionRequest>;

export const CANCELLED_BY = ['patient', 'professional', 'organization'] as const;
export type CancelledBy = (typeof CANCELLED_BY)[number];

/** Reasons for cancelling. A code, so reports can group them; the free text is optional. */
export const CANCELLATION_REASONS = [
  'patient_request',
  'illness',
  'schedule_conflict',
  'no_longer_needed',
  'professional_unavailable',
  'organization_closed',
  'duplicate',
  'other',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const CancelAppointmentRequest = z.strictObject({
  cancelledBy: z.enum(CANCELLED_BY),
  reasonCode: z.enum(CANCELLATION_REASONS),
  note: z.string().trim().max(200).optional(),
  expectedVersion: ExpectedVersion.optional(),
});
export type CancelAppointmentRequest = z.infer<typeof CancelAppointmentRequest>;

/** An authorized correction of a terminal status needs a reason (audited). */
export const CorrectStatusRequest = z.strictObject({
  toStatus: z.enum(APPOINTMENT_STATUSES),
  reason: z.string().trim().min(1).max(200),
  expectedVersion: ExpectedVersion.optional(),
});
export type CorrectStatusRequest = z.infer<typeof CorrectStatusRequest>;

/**
 * Moves an appointment to another time, location or professional. The version is required: a move
 * decided on a stale screen must not overwrite a change somebody else made.
 */
export const RescheduleRequest = z
  .object({
    expectedVersion: ExpectedVersion,
    startsAt: Instant.optional(),
    local: LocalStart.optional(),
    professionalId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    overrideHours: OverrideHours.optional(),
    overrideHold: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.startsAt !== undefined && value.local !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['startsAt'],
        message: 'give either an instant or a local time',
      });
    }
    if (
      value.startsAt === undefined &&
      value.local === undefined &&
      value.professionalId === undefined &&
      value.locationId === undefined
    ) {
      ctx.addIssue({ code: 'custom', path: ['startsAt'], message: 'nothing to change' });
    }
  });
export type RescheduleRequest = z.infer<typeof RescheduleRequest>;

export const APPOINTMENT_EVENT_KINDS = [
  'created',
  'status_changed',
  'rescheduled',
  'reassigned',
  'status_corrected',
  'identity_confirmed',
  'identity_rejected',
] as const;
export type AppointmentEventKind = (typeof APPOINTMENT_EVENT_KINDS)[number];

export const AppointmentEventDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(APPOINTMENT_EVENT_KINDS),
  fromStatus: z.enum(APPOINTMENT_STATUSES).nullable(),
  toStatus: z.enum(APPOINTMENT_STATUSES).nullable(),
  actorUserId: z.uuid().nullable(),
  actorKind: z.enum(['staff', 'patient', 'system']),
  at: Instant,
  details: z.record(z.string(), z.unknown()),
});
export type AppointmentEventDto = z.infer<typeof AppointmentEventDto>;

export const AppointmentHistoryResponse = z.strictObject({
  appointmentId: z.uuid(),
  /** How many times it was moved: derived from the history, never a status. */
  rescheduledCount: z.number().int(),
  events: z.array(AppointmentEventDto),
});
export type AppointmentHistoryResponse = z.infer<typeof AppointmentHistoryResponse>;

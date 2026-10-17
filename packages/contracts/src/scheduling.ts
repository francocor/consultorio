import { z } from 'zod';

import { BlockDto, HolidayDto } from './scheduling-config.js';

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
    /** Finishes a slot hold: the booking takes the held range and the hold ends as converted. */
    holdId: z.uuid().optional(),
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
  /** How a pending identity was confirmed; null when it never needed confirming. */
  identityConfirmation: z.enum(['staff', 'self_confirmed']).nullable(),
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

/**
 * Optimistic concurrency: every write of an appointment names the version the screen was showing,
 * and a stale `expectedVersion` gets 409 `stale_revision`. It is required, never optional: a change
 * decided on a stale screen must not overwrite what somebody else did.
 */
export const TransitionRequest = z.strictObject({ expectedVersion: ExpectedVersion });
export type TransitionRequest = z.infer<typeof TransitionRequest>;

/**
 * Check-in. `confirmIdentity` is the in-person confirmation: the staff member saw the patient and
 * the ID document. Staff other than the appointment's professional confirm with it; the
 * professional's own check-in confirms only in a solo practice (D18).
 */
export const CheckInRequest = z.strictObject({
  expectedVersion: ExpectedVersion,
  confirmIdentity: z.boolean().optional(),
});
export type CheckInRequest = z.infer<typeof CheckInRequest>;

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
  expectedVersion: ExpectedVersion,
});
export type CancelAppointmentRequest = z.infer<typeof CancelAppointmentRequest>;

/** An authorized correction of a terminal status needs a reason (audited). */
export const CorrectStatusRequest = z.strictObject({
  toStatus: z.enum(APPOINTMENT_STATUSES),
  reason: z.string().trim().min(1).max(200),
  expectedVersion: ExpectedVersion,
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

// Reception worklist --------------------------------------------------------------------------

/**
 * The six kinds of item that need a person (scheduling, "Reception worklist"). Other capabilities
 * add their items here instead of keeping queues of their own.
 */
export const WORKLIST_KINDS = [
  'pending_approval',
  'identity_review',
  'reminder_not_sent',
  'reminder_not_delivered',
  'reply_to_review',
  'waitlist_manual_contact',
] as const;
export type WorklistKind = (typeof WORKLIST_KINDS)[number];

export const WORKLIST_SUBJECT_TYPES = ['appointment', 'waitlist_entry', 'inbound_message'] as const;
export type WorklistSubjectType = (typeof WORKLIST_SUBJECT_TYPES)[number];

export const WORKLIST_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type WorklistStatus = (typeof WORKLIST_STATUSES)[number];

/** What a person can do with an item; the screen links each one to its action. */
export const WORKLIST_ACTIONS = [
  'open_appointment',
  'approve',
  'confirm_identity',
  'detach_patient',
  'resolve',
  'dismiss',
] as const;
export type WorklistAction = (typeof WORKLIST_ACTIONS)[number];

/** The appointment an item is about, with administrative data only. */
export const WorklistAppointmentDto = z.strictObject({
  id: z.uuid(),
  startsAt: Instant,
  endsAt: Instant,
  status: z.enum(APPOINTMENT_STATUSES),
  professionalId: z.uuid(),
  patientId: z.uuid(),
  patientName: z.string(),
  locationId: z.uuid(),
  identityConfirmed: z.boolean(),
  /** What the item's actions (confirm the identity, detach the patient) name as `expectedVersion`. */
  version: z.number().int(),
});
export type WorklistAppointmentDto = z.infer<typeof WorklistAppointmentDto>;

export const WorklistItemDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(WORKLIST_KINDS),
  subjectType: z.enum(WORKLIST_SUBJECT_TYPES),
  subjectId: z.uuid(),
  locationId: z.uuid().nullable(),
  status: z.enum(WORKLIST_STATUSES),
  createdAt: Instant,
  resolvedAt: Instant.nullable(),
  resolvedBy: z.uuid().nullable(),
  resolution: z.string().nullable(),
  /** Administrative detail, for example the differences between a booking and the record. */
  detail: z.record(z.string(), z.unknown()).nullable(),
  appointment: WorklistAppointmentDto.nullable(),
  actions: z.array(z.enum(WORKLIST_ACTIONS)),
});
export type WorklistItemDto = z.infer<typeof WorklistItemDto>;

export const WorklistQuery = z.strictObject({
  status: z.enum(WORKLIST_STATUSES).optional(),
  kind: z.enum(WORKLIST_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type WorklistQuery = z.infer<typeof WorklistQuery>;

export const WorklistResponse = z.strictObject({
  items: z.array(WorklistItemDto),
  /** Open items the viewer can see, for the badge on the navigation. */
  openCount: z.number().int(),
});
export type WorklistResponse = z.infer<typeof WorklistResponse>;

// Identity review (D14, D18) ------------------------------------------------------------------

/** Confirms the identity of the appointment an identity review is about. */
export const ConfirmIdentityRequest = z.strictObject({
  expectedVersion: ExpectedVersion,
});
export type ConfirmIdentityRequest = z.infer<typeof ConfirmIdentityRequest>;

/**
 * The match was wrong: move the appointment to another patient record, or cancel it. The record
 * that was matched is left exactly as it was.
 */
export const DetachPatientRequest = z.discriminatedUnion('resolution', [
  z.strictObject({
    resolution: z.literal('move_to_patient'),
    patientId: z.uuid(),
    expectedVersion: ExpectedVersion,
  }),
  z.strictObject({
    resolution: z.literal('cancel'),
    cancelledBy: z.enum(CANCELLED_BY),
    reasonCode: z.enum(CANCELLATION_REASONS),
    note: z.string().trim().max(200).optional(),
    expectedVersion: ExpectedVersion,
  }),
]);
export type DetachPatientRequest = z.infer<typeof DetachPatientRequest>;

// Slot holds ----------------------------------------------------------------------------------

export const HOLD_STATUSES = ['active', 'converted', 'expired', 'released', 'invalidated'] as const;
export type HoldStatus = (typeof HOLD_STATUSES)[number];

/** Starts a short reservation of a range while a booking is completed. */
export const CreateHoldRequest = z
  .object({
    professionalId: z.uuid(),
    locationId: z.uuid(),
    appointmentTypeId: z.uuid(),
    startsAt: Instant.optional(),
    local: LocalStart.optional(),
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
export type CreateHoldRequest = z.infer<typeof CreateHoldRequest>;

/** A hold has no patient and no appointment status: it is only a reserved range. */
export const HoldDto = z.strictObject({
  id: z.uuid(),
  professionalId: z.uuid(),
  locationId: z.uuid(),
  startsAt: Instant,
  endsAt: Instant,
  expiresAt: Instant,
  status: z.enum(HOLD_STATUSES),
  origin: z.enum(['public', 'staff']),
});
export type HoldDto = z.infer<typeof HoldDto>;

// Availability --------------------------------------------------------------------------------

/** The longest window of days one availability request may cover. */
export const MAX_AVAILABILITY_DAYS = 31;

export const AvailabilityQuery = z
  .strictObject({
    professionalId: z.uuid(),
    typeId: z.uuid(),
    /** First local date (`YYYY-MM-DD`, in each location's zone), included. */
    from: z.iso.date(),
    /** Last local date, included. */
    to: z.iso.date(),
    /** Only this location; omit for every location where the professional works. */
    locationId: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const days =
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000;
    if (days < 0) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the start' });
    } else if (days + 1 > MAX_AVAILABILITY_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'at most 31 days at a time' });
    }
  });
export type AvailabilityQuery = z.infer<typeof AvailabilityQuery>;

export const AvailableSlotDto = z.strictObject({
  startsAt: Instant,
  endsAt: Instant,
  locationId: z.uuid(),
  /** The local date of the start, in the location's zone. */
  date: z.iso.date(),
});
export type AvailableSlotDto = z.infer<typeof AvailableSlotDto>;

/** A date on which nothing is offered because the calendar is closed (a holiday or a day off). */
export const ClosedDayDto = z.strictObject({
  date: z.iso.date(),
  locationId: z.uuid(),
  name: z.string(),
  source: z.enum(['national', 'bridge', 'organization']),
});
export type ClosedDayDto = z.infer<typeof ClosedDayDto>;

export const AvailabilityResponse = z.strictObject({
  professionalId: z.uuid(),
  typeId: z.uuid(),
  slots: z.array(AvailableSlotDto),
  closedDays: z.array(ClosedDayDto),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponse>;

// Recurring series ----------------------------------------------------------------------------

export const SERIES_MAX_OCCURRENCES = 52;

export const SeriesRecurrence = z
  .strictObject({
    frequency: z.literal('weekly'),
    /** Every how many weeks (1 is weekly, 2 every other week). */
    everyWeeks: z.number().int().min(1).max(8).default(1),
    /** Total sessions, the first included. */
    count: z.number().int().min(2).max(SERIES_MAX_OCCURRENCES).optional(),
    /** The last date (in the location's zone) a session may start on. */
    until: z.iso.date().optional(),
  })
  .refine((value) => (value.count === undefined) !== (value.until === undefined), {
    message: 'give either a count or an end date',
  });
export type SeriesRecurrence = z.infer<typeof SeriesRecurrence>;

/**
 * A weekly (or every-N-weeks) series. `dry_run` reports every session without creating anything;
 * `commit` creates the sessions in one go, leaving out the `skip` ones, and creates NOTHING if any
 * session that is not skipped conflicts.
 */
export const BookSeriesRequest = z
  .object({
    patientId: z.uuid(),
    professionalId: z.uuid(),
    locationId: z.uuid(),
    appointmentTypeId: z.uuid(),
    /** The first session. Exactly one of `startsAt` and `local`. */
    startsAt: Instant.optional(),
    local: LocalStart.optional(),
    recurrence: SeriesRecurrence,
    mode: z.enum(['dry_run', 'commit']),
    /** Sessions to leave out, by their number (1 is the first). Only meaningful when committing. */
    skip: z
      .array(z.number().int().min(1).max(SERIES_MAX_OCCURRENCES))
      .max(SERIES_MAX_OCCURRENCES)
      .default([]),
    overrideHours: OverrideHours.optional(),
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
export type BookSeriesRequest = z.infer<typeof BookSeriesRequest>;

export const SERIES_CONFLICT_REASONS = [
  'slot_taken',
  'outside_working_hours',
  'blocked',
  'holiday',
  'in_past',
  'local_time_nonexistent',
  'local_time_ambiguous',
] as const;
export type SeriesConflictReason = (typeof SERIES_CONFLICT_REASONS)[number];

export const SeriesOccurrenceDto = z.strictObject({
  /** 1 is the first session. */
  index: z.number().int().min(1),
  startsAt: Instant.nullable(),
  endsAt: Instant.nullable(),
  status: z.enum(['ok', 'conflict', 'skipped']),
  reason: z.enum(SERIES_CONFLICT_REASONS).nullable(),
});
export type SeriesOccurrenceDto = z.infer<typeof SeriesOccurrenceDto>;

export const SeriesPreviewResponse = z.strictObject({
  mode: z.literal('dry_run'),
  occurrences: z.array(SeriesOccurrenceDto),
  /** True when every session that is not skipped can be created. */
  canCommit: z.boolean(),
});
export type SeriesPreviewResponse = z.infer<typeof SeriesPreviewResponse>;

export const SeriesCommitResponse = z.strictObject({
  mode: z.literal('commit'),
  seriesId: z.uuid(),
  appointments: z.array(AppointmentDto),
  skipped: z.array(z.number().int()),
});
export type SeriesCommitResponse = z.infer<typeof SeriesCommitResponse>;

/** The extra members of the 409 that refuses a commit: which sessions conflict. */
export const SeriesConflictExtension = z.strictObject({
  occurrences: z.array(SeriesOccurrenceDto),
});
export type SeriesConflictExtension = z.infer<typeof SeriesConflictExtension>;

// Calendar feed --------------------------------------------------------------------------------

/** The longest window one calendar request covers (a month view plus its edges). */
export const MAX_CALENDAR_DAYS = 62;

export const CalendarQuery = z
  .strictObject({
    from: Instant,
    to: Instant,
    /** Comma separated professional ids. Omit for everyone the viewer may see. */
    professionalIds: z
      .string()
      .transform((value) => value.split(',').filter((part) => part !== ''))
      .pipe(z.array(z.uuid()).max(50))
      .optional(),
    locationId: z.uuid().optional(),
  })
  .superRefine((value, ctx) => {
    const span = Date.parse(value.to) - Date.parse(value.from);
    if (!(span > 0)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must be after the start' });
    } else if (span > MAX_CALENDAR_DAYS * 86_400_000) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'at most 62 days at a time' });
    }
  });
export type CalendarQuery = z.infer<typeof CalendarQuery>;

/**
 * An entry of the calendar: administrative data only (the patient's name, the type, the status and
 * the time), never anything clinical.
 */
export const CalendarEntryDto = AppointmentDto.extend({
  patientName: z.string(),
  typeName: z.string(),
  typeColor: z.string().nullable(),
});
export type CalendarEntryDto = z.infer<typeof CalendarEntryDto>;

export const CalendarResponse = z.strictObject({
  appointments: z.array(CalendarEntryDto),
  /** Blocks that touch the window, so the grid can show them. */
  blocks: z.array(BlockDto),
  /** Holidays and days off in the window. */
  holidays: z.array(HolidayDto),
  /**
   * True when the window holds more appointments than one answer carries: the earliest ones are
   * here and the rest is missing, so the screen asks to narrow the filter (fewer days, one
   * professional or one location). False means nothing is missing.
   */
  truncated: z.boolean(),
});
export type CalendarResponse = z.infer<typeof CalendarResponse>;

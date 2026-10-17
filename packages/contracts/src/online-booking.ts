import { z } from 'zod';

import { DocumentInput } from './patients.js';
import { APPOINTMENT_MODES } from './scheduling-config.js';

/**
 * Contracts of the online-booking module (public booking links, holds, verified submissions). This
 * file holds what is certain from the design and the spec; the public-booking track (S3.07 to
 * S3.10) adds its request and response shapes below, in this file only.
 */

/**
 * Error codes of the online-booking module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.online-booking.json`, keyed by the
 * code. The track adds its codes here.
 */
export const ONLINE_BOOKING_ERRORS = {
  // The visitor did not solve the bot challenge (missing, wrong, expired or used twice).
  booking_challenge_failed: { status: 400, i18nKey: 'errors.booking_challenge_failed' },
  // The one-time code is wrong, expired or spent. One answer for all of them.
  booking_code_invalid: { status: 400, i18nKey: 'errors.booking_code_invalid' },
  // The contact already holds the most future online appointments, or the day's bookings are used.
  booking_limit_reached: { status: 409, i18nKey: 'errors.booking_limit_reached' },
  // The link to change or cancel an appointment came after the organization's deadline.
  booking_change_deadline_passed: {
    status: 409,
    i18nKey: 'errors.booking_change_deadline_passed',
  },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of online booking. They are registered in the shared catalogue. */
export const ONLINE_BOOKING_AUDIT_ACTIONS = [
  'booking.link.enabled',
  'booking.link.disabled',
  'booking.link.regenerated',
  'booking.online.created',
  'booking.suspicious',
] as const;

/** The `onlineBooking` section of the organization settings (spec defaults). */
export const OnlineBookingSettings = z.strictObject({
  /** The earliest bookable slot starts this many hours from now. */
  minLeadHours: z
    .int()
    .min(0)
    .max(24 * 14),
  /** The furthest bookable day, in days from today. */
  horizonDays: z.int().min(1).max(365),
  /** Most online bookings per professional and day; null means no cap. */
  dailyCap: z.int().min(1).max(500).nullable(),
  /** Until this many hours before the start a patient may change or cancel by link. */
  rescheduleDeadlineHours: z
    .int()
    .min(0)
    .max(24 * 14),
  /** An online booking waits for staff approval before it is scheduled. */
  requireApproval: z.boolean(),
});
export type OnlineBookingSettings = z.infer<typeof OnlineBookingSettings>;

export const DEFAULT_ONLINE_BOOKING_SETTINGS: OnlineBookingSettings = {
  minLeadHours: 2,
  horizonDays: 60,
  dailyCap: null,
  rescheduleDeadlineHours: 12,
  requireApproval: false,
};

const Id = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const LINK_SLUG = /^[a-z0-9]{8,32}$/;
const LinkSlug = z.string().regex(LINK_SLUG);
/** What a public request names a professional by. Not checked against the slug format on purpose: a malformed name answers like an unknown one (404), never differently. */
const LinkName = z.string().min(1).max(64);

/** Longest range of dates one availability answer covers. */
export const MAX_PUBLIC_AVAILABILITY_DAYS = 31;

// Staff: the links of the organization ---------------------------------------------------------

export const BookingLinkDto = z.strictObject({
  id: Id,
  /** Null for the link of the organization itself. */
  professionalId: Id.nullable(),
  slug: z.string(),
  enabled: z.boolean(),
  /** Empty: every location the professional works at. */
  locationIds: z.array(Id),
  /** Empty: nothing is bookable yet. */
  typeIds: z.array(Id),
  regeneratedAt: Instant.nullable(),
  /** Where the visitor opens it in the web app, such as `/book/abc123` or `/book/abc123/p/def456`. */
  path: z.string().nullable(),
});
export type BookingLinkDto = z.infer<typeof BookingLinkDto>;

export const BookingLinksResponse = z.strictObject({ links: z.array(BookingLinkDto) });
export type BookingLinksResponse = z.infer<typeof BookingLinksResponse>;

/** Creates the link of the organization (no professional) or of one professional. Disabled at first. */
export const CreateBookingLinkRequest = z.strictObject({
  professionalId: Id.optional(),
  enabled: z.boolean().optional(),
  locationIds: z.array(Id).max(50).optional(),
  typeIds: z.array(Id).max(50).optional(),
});
export type CreateBookingLinkRequest = z.infer<typeof CreateBookingLinkRequest>;

export const UpdateBookingLinkRequest = z
  .strictObject({
    enabled: z.boolean(),
    locationIds: z.array(Id).max(50),
    typeIds: z.array(Id).max(50),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field to change');
export type UpdateBookingLinkRequest = z.infer<typeof UpdateBookingLinkRequest>;

// Public: what a visitor sees ------------------------------------------------------------------

export const PublicTypeDto = z.strictObject({
  id: Id,
  name: z.string(),
  durationMinutes: z.number().int(),
  mode: z.enum(APPOINTMENT_MODES),
});
export type PublicTypeDto = z.infer<typeof PublicTypeDto>;

export const PublicLocationDto = z.strictObject({
  id: Id,
  name: z.string(),
  /** The zone slots are shown in; the screen labels it. */
  timeZone: z.string(),
});
export type PublicLocationDto = z.infer<typeof PublicLocationDto>;

/** A professional as the public sees them: named by their link, never by an internal id. */
export const PublicProfessionalDto = z.strictObject({
  slug: LinkSlug,
  name: z.string(),
  specialties: z.array(z.string()),
  types: z.array(PublicTypeDto),
  locations: z.array(PublicLocationDto),
});
export type PublicProfessionalDto = z.infer<typeof PublicProfessionalDto>;

export const PublicBookingPageDto = z.strictObject({
  organizationName: z.string(),
  scope: z.enum(['organization', 'professional']),
  professionals: z.array(PublicProfessionalDto),
  /** The booking will wait for the organization's approval. Said up front, before the form. */
  requiresApproval: z.boolean(),
  horizonDays: z.number().int(),
});
export type PublicBookingPageDto = z.infer<typeof PublicBookingPageDto>;

// The inputs of the public routes are not strict: a field the page does not define (a forged
// organization, role or patient identifier) is dropped, never used (online-booking, "Abuse
// protection": "MUST ignore any client-supplied organization, role or patient identifiers").
export const PublicAvailabilityQuery = z
  .object({
    /** The slug of the professional's own link. */
    professional: LinkName,
    typeId: Id,
    locationId: Id.optional(),
    from: z.iso.date(),
    to: z.iso.date(),
  })
  .superRefine((value, ctx) => {
    const days =
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000;
    if (days < 0) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the start' });
    } else if (days + 1 > MAX_PUBLIC_AVAILABILITY_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'at most 31 days at a time' });
    }
  });
export type PublicAvailabilityQuery = z.infer<typeof PublicAvailabilityQuery>;

export const PublicSlotDto = z.strictObject({
  startsAt: Instant,
  endsAt: Instant,
  locationId: Id,
  /** The local date of the start, in the location's zone. */
  date: z.iso.date(),
});
export type PublicSlotDto = z.infer<typeof PublicSlotDto>;

export const PublicAvailabilityResponse = z.strictObject({
  slots: z.array(PublicSlotDto),
  /** When the range is empty: the first free time after it inside the horizon, else null. */
  nextAvailable: PublicSlotDto.nullable(),
});
export type PublicAvailabilityResponse = z.infer<typeof PublicAvailabilityResponse>;

/** The puzzle the browser solves before it holds a slot or submits the form. */
export const PublicChallengeResponse = z.strictObject({
  kind: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type PublicChallengeResponse = z.infer<typeof PublicChallengeResponse>;

export const PublicHoldRequest = z.object({
  professional: LinkName,
  locationId: Id,
  appointmentTypeId: Id,
  startsAt: Instant,
  challengeProof: z.string().min(1).max(512),
});
export type PublicHoldRequest = z.infer<typeof PublicHoldRequest>;

export const PublicHoldDto = z.strictObject({
  id: Id,
  startsAt: Instant,
  endsAt: Instant,
  expiresAt: Instant,
  locationId: Id,
  appointmentTypeId: Id,
});
export type PublicHoldDto = z.infer<typeof PublicHoldDto>;

// Public: the form and the code ----------------------------------------------------------------

const PersonName = z.string().trim().min(1).max(80);
const Phone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9+()\-\s.]*$/, 'digits and phone punctuation only');

/** Longest administrative reason a visitor may add. It is text for reception, never a clinical note. */
export const MAX_BOOKING_REASON_LENGTH = 300;

/**
 * The form of a public booking (online-booking, "Booking completion and patient identification"):
 * what is needed to book and nothing clinical. The WhatsApp choice is a separate, unticked box; the
 * consent to process the data is required and is checked by the API, which answers a missing one with
 * a field error the page can show.
 */
export const PublicSubmissionRequest = z.object({
  givenNames: PersonName,
  familyName: PersonName,
  document: DocumentInput,
  birthDate: z.iso.date(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  /** Needed only for WhatsApp reminders. */
  phone: Phone.optional(),
  whatsappOptIn: z.boolean().default(false),
  dataProcessingConsent: z.boolean(),
  /** Administrative text; the page warns not to write health details in it. */
  reason: z.string().trim().max(MAX_BOOKING_REASON_LENGTH).optional(),
  challengeProof: z.string().min(1).max(512),
});
export type PublicSubmissionRequest = z.infer<typeof PublicSubmissionRequest>;

export const PublicSubmissionResponse = z.strictObject({
  /** The address the code went to, hidden in part, so the visitor can see they typed it right. */
  maskedEmail: z.string(),
  codeExpiresAt: Instant,
});
export type PublicSubmissionResponse = z.infer<typeof PublicSubmissionResponse>;

/** Asks for the code again: it is one more email, so it carries a proof of the bot challenge. */
export const PublicResendRequest = z.object({ challengeProof: z.string().min(1).max(512) });
export type PublicResendRequest = z.infer<typeof PublicResendRequest>;

export const PUBLIC_CODE_LENGTH = 6;

export const PublicConfirmRequest = z.object({
  code: z.string().regex(/^\d{6}$/),
});
export type PublicConfirmRequest = z.infer<typeof PublicConfirmRequest>;

// Public: the confirmation and the link to change it ------------------------------------------

/** What the page says about an appointment: when, where and with whom. Never anything of the patient. */
const PublicAppointmentFields = {
  status: z.enum(['scheduled', 'pending_approval', 'confirmed', 'cancelled']),
  startsAt: Instant,
  endsAt: Instant,
  timeZone: z.string(),
  professionalName: z.string(),
  locationName: z.string(),
  typeName: z.string(),
  mode: z.enum(APPOINTMENT_MODES),
};

/**
 * The same answer for every visitor who confirms a booking, whether or not the person already
 * existed as a patient (online-booking, "Booking completion"). `managePath` is the link to change or
 * cancel, also sent by email.
 */
export const PublicConfirmationDto = z.strictObject({
  status: z.enum(['scheduled', 'pending_approval']),
  startsAt: Instant,
  endsAt: Instant,
  timeZone: z.string(),
  organizationName: z.string(),
  professionalName: z.string(),
  locationName: z.string(),
  typeName: z.string(),
  mode: z.enum(APPOINTMENT_MODES),
  /** An iCalendar file with the date, the place and the professional; nothing clinical. */
  calendarFile: z.string(),
  /** Null when the appointment is about to start and there is nothing left to change. */
  managePath: z.string().nullable(),
});
export type PublicConfirmationDto = z.infer<typeof PublicConfirmationDto>;

/** The appointment behind a link, and whether the patient can still change it. */
export const PublicManageDto = z.strictObject({
  appointment: z.strictObject(PublicAppointmentFields),
  organizationName: z.string(),
  /** False after the deadline of the organization: the page then says to contact it. */
  canChange: z.boolean(),
  /** The last instant the patient can change or cancel by link. */
  changeDeadline: Instant,
});
export type PublicManageDto = z.infer<typeof PublicManageDto>;

export const PublicManageSlotsQuery = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .superRefine((value, ctx) => {
    const days =
      (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000;
    if (days < 0) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'must not be before the start' });
    } else if (days + 1 > MAX_PUBLIC_AVAILABILITY_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'at most 31 days at a time' });
    }
  });
export type PublicManageSlotsQuery = z.infer<typeof PublicManageSlotsQuery>;

export const PublicRescheduleRequest = z.object({ startsAt: Instant });
export type PublicRescheduleRequest = z.infer<typeof PublicRescheduleRequest>;

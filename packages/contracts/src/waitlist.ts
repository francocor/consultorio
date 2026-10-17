import { z } from 'zod';

import { DocumentInput } from './patients.js';

/**
 * Contracts of the waitlist module (entries, offers of freed slots). The tenant and the person who
 * acts are never fields: both come from the session. Staff requests are strict; the public join
 * form is not (a forged organization, role or patient identifier is dropped, never used).
 */

export const WAITLIST_ENTRY_STATUSES = ['active', 'paused', 'offered', 'closed'] as const;
export type WaitlistEntryStatus = (typeof WAITLIST_ENTRY_STATUSES)[number];

export const WAITLIST_OFFER_STATUSES = [
  'open',
  'accepted',
  'declined',
  'expired',
  'invalidated',
] as const;
export type WaitlistOfferStatus = (typeof WAITLIST_OFFER_STATUSES)[number];

export const WAITLIST_CLOSE_REASONS = [
  'fulfilled',
  'expired',
  'cancelled',
  'patient_opted_out',
] as const;
export type WaitlistCloseReason = (typeof WAITLIST_CLOSE_REASONS)[number];

/** Why an offer ended without a booking, besides being declined or expiring. */
export const WAITLIST_OFFER_END_REASONS = [
  'slot_taken',
  'slot_unavailable',
  'undeliverable',
  'patient_opted_out',
  'entry_closed',
] as const;
export type WaitlistOfferEndReason = (typeof WAITLIST_OFFER_END_REASONS)[number];

/** The channels an offer may travel on. Never SMS (design D5). */
export const WAITLIST_CHANNELS = ['email', 'whatsapp'] as const;
export type WaitlistChannel = (typeof WAITLIST_CHANNELS)[number];

/** Who recorded the patient's agreement to receive offers. */
export const WAITLIST_OPT_IN_SOURCES = ['staff', 'public_join'] as const;
export type WaitlistOptInSource = (typeof WAITLIST_OPT_IN_SOURCES)[number];

/** How an entry came to exist. */
export const WAITLIST_ENTRY_SOURCES = ['staff', 'public_join'] as const;
export type WaitlistEntrySource = (typeof WAITLIST_ENTRY_SOURCES)[number];

/** Why automated offers are not sent for an entry: reception calls the patient instead. */
export const WAITLIST_MANUAL_REASONS = [
  'no_offers_opt_in',
  'no_reachable_channel',
  'patient_opted_out',
  'undeliverable',
] as const;
export type WaitlistManualReason = (typeof WAITLIST_MANUAL_REASONS)[number];

/** Why reception sees a freed slot with the entries to call. */
export const WAITLIST_CALL_REASONS = [
  'manual_contact_only',
  'slot_too_close',
  'quiet_hours',
  'undeliverable',
] as const;
export type WaitlistCallReason = (typeof WAITLIST_CALL_REASONS)[number];

/** Priority overrides are audited: 0 is the order of waiting, 1 goes first, 2 goes before those. */
export const WAITLIST_PRIORITIES = [0, 1, 2] as const;

/** Offers that expire in a row before an entry is flagged for reception. */
export const WAITLIST_FLAG_AFTER_EXPIRED = 3;

/**
 * Error codes of the waitlist module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.waitlist.json`, keyed by the
 * code.
 */
export const WAITLIST_ERRORS = {
  // The patient already holds the most active entries the organization allows.
  waitlist_entry_limit: { status: 409, i18nKey: 'errors.waitlist_entry_limit' },
  // The entry is closed or expired: nothing can be changed on it.
  waitlist_entry_closed: { status: 409, i18nKey: 'errors.waitlist_entry_closed' },
  // The patient is inactive, or the type, professional or place cannot be waited for.
  waitlist_not_available: { status: 409, i18nKey: 'errors.waitlist_not_available' },
  // The joining visitor did not tick the agreement to receive offers.
  waitlist_opt_in_required: { status: 400, i18nKey: 'errors.waitlist_opt_in_required' },
  // The one-time code of a join is wrong, expired or spent. One answer for all of them.
  waitlist_code_invalid: { status: 400, i18nKey: 'errors.waitlist_code_invalid' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of the waitlist. They are registered in the shared catalogue. */
export const WAITLIST_AUDIT_ACTIONS = [
  'waitlist.entry.created',
  'waitlist.entry.updated',
  'waitlist.entry.closed',
  'waitlist.offer.created',
  'waitlist.offer.accepted',
  'waitlist.offer.declined',
  'waitlist.offer.expired',
  'waitlist.priority.overridden',
] as const;

/** The `waitlist` section of the organization settings (spec defaults). */
export const WaitlistSettings = z.strictObject({
  /** An entry becomes inactive after this many days. */
  entryExpiryDays: z.int().min(1).max(365),
  /** How long an offer stays open (shortened when the slot is near). */
  offerWindowMinutes: z.int().min(5).max(240),
  /** A slot starting sooner than this is not offered through automated messages. */
  minOfferLeadMinutes: z
    .int()
    .min(0)
    .max(24 * 60),
  /** Most active entries one patient may hold. */
  maxActiveEntries: z.int().min(1).max(20),
});
export type WaitlistSettings = z.infer<typeof WaitlistSettings>;

export const DEFAULT_WAITLIST_SETTINGS: WaitlistSettings = {
  entryExpiryDays: 60,
  offerWindowMinutes: 30,
  minOfferLeadMinutes: 60,
  maxActiveEntries: 5,
};

// Preferences ----------------------------------------------------------------------------------

const Id = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');

/** The most time ranges an entry lists. */
const MAX_TIME_RANGES = 6;

/** A part of the day the patient can come, in the local time of the location. */
export const WaitlistTimeRange = z
  .strictObject({ from: ClockTime, to: ClockTime })
  .refine((range) => range.from < range.to, 'the range must end after it starts');
export type WaitlistTimeRange = z.infer<typeof WaitlistTimeRange>;

/** Days of the week, 1 (Monday) to 7 (Sunday). Sorted and unique; empty means any day. */
const Weekdays = z
  .array(z.int().min(1).max(7))
  .max(7)
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

/** Which days and times suit the patient, and between which dates. Empty means no preference. */
const preferenceFields = {
  weekdays: Weekdays.default([]),
  timeRanges: z.array(WaitlistTimeRange).max(MAX_TIME_RANGES).default([]),
  earliestDate: z.iso.date().nullable().optional(),
  latestDate: z.iso.date().nullable().optional(),
};

function datesInOrder(value: {
  earliestDate?: string | null | undefined;
  latestDate?: string | null | undefined;
}): boolean {
  return (
    value.earliestDate == null || value.latestDate == null || value.earliestDate <= value.latestDate
  );
}
const DATES_IN_ORDER = 'the latest date must not be before the earliest';

// Staff ---------------------------------------------------------------------------------------

export const CreateWaitlistEntryRequest = z
  .strictObject({
    patientId: Id,
    appointmentTypeId: Id,
    /** Absent or null: any professional that offers the type. */
    professionalId: Id.nullable().optional(),
    /** Absent or null: any location. */
    locationId: Id.nullable().optional(),
    ...preferenceFields,
    /** The patient agreed to receive waitlist offers; the staff member records what they said. */
    offersOptIn: z.boolean(),
    channels: z.array(z.enum(WAITLIST_CHANNELS)).min(1).max(2).default(['email']),
  })
  .refine(datesInOrder, { path: ['latestDate'], message: DATES_IN_ORDER });
export type CreateWaitlistEntryRequest = z.infer<typeof CreateWaitlistEntryRequest>;

export const UpdateWaitlistEntryRequest = z
  .strictObject({
    professionalId: Id.nullable(),
    locationId: Id.nullable(),
    weekdays: Weekdays,
    timeRanges: z.array(WaitlistTimeRange).max(MAX_TIME_RANGES),
    earliestDate: z.iso.date().nullable(),
    latestDate: z.iso.date().nullable(),
    channels: z.array(z.enum(WAITLIST_CHANNELS)).min(1).max(2),
    /** Records the agreement the patient gave later. It can only be turned on. */
    offersOptIn: z.literal(true),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field to change')
  .refine(datesInOrder, { path: ['latestDate'], message: DATES_IN_ORDER });
export type UpdateWaitlistEntryRequest = z.infer<typeof UpdateWaitlistEntryRequest>;

/** A staff member closes an entry by hand: the patient was booked elsewhere, or no longer wants it. */
export const CloseWaitlistEntryRequest = z.strictObject({
  reason: z.enum(['fulfilled', 'cancelled']),
});
export type CloseWaitlistEntryRequest = z.infer<typeof CloseWaitlistEntryRequest>;

export const SetWaitlistPriorityRequest = z.strictObject({
  priority: z.int().min(0).max(2),
});
export type SetWaitlistPriorityRequest = z.infer<typeof SetWaitlistPriorityRequest>;

export const WaitlistListQuery = z.strictObject({
  /** Default: the entries still in play (active, paused or with an offer open). */
  status: z.enum(WAITLIST_ENTRY_STATUSES).optional(),
  patientId: Id.optional(),
  professionalId: Id.optional(),
  /** Entries a booking of this type would fulfil (the "close this entry?" prompt). */
  appointmentTypeId: Id.optional(),
  /** Only the entries that let three offers expire in a row. */
  unresponsive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type WaitlistListQuery = z.infer<typeof WaitlistListQuery>;

export const WaitlistOfferDto = z.strictObject({
  id: Id,
  status: z.enum(WAITLIST_OFFER_STATUSES),
  endReason: z.enum(WAITLIST_OFFER_END_REASONS).nullable(),
  professionalId: Id,
  locationId: Id,
  startsAt: Instant,
  endsAt: Instant,
  createdAt: Instant,
  expiresAt: Instant,
  /** When the offer stopped being open: answered, expired or invalidated. */
  closedAt: Instant.nullable(),
  channel: z.enum(WAITLIST_CHANNELS).nullable(),
  appointmentId: Id.nullable(),
});
export type WaitlistOfferDto = z.infer<typeof WaitlistOfferDto>;

export const WaitlistEntryDto = z.strictObject({
  id: Id,
  patientId: Id,
  patientName: z.string(),
  appointmentTypeId: Id,
  appointmentTypeName: z.string(),
  professionalId: Id.nullable(),
  professionalName: z.string().nullable(),
  locationId: Id.nullable(),
  locationName: z.string().nullable(),
  weekdays: z.array(z.int()),
  timeRanges: z.array(WaitlistTimeRange),
  earliestDate: z.iso.date().nullable(),
  latestDate: z.iso.date().nullable(),
  status: z.enum(WAITLIST_ENTRY_STATUSES),
  closeReason: z.enum(WAITLIST_CLOSE_REASONS).nullable(),
  closedAt: Instant.nullable(),
  expiresAt: Instant,
  /** Automated offers are not sent; reception calls the patient. */
  manualContactOnly: z.boolean(),
  manualReason: z.enum(WAITLIST_MANUAL_REASONS).nullable(),
  offersOptInAt: Instant.nullable(),
  offersOptInSource: z.enum(WAITLIST_OPT_IN_SOURCES).nullable(),
  channels: z.array(z.enum(WAITLIST_CHANNELS)),
  priority: z.int().min(0).max(2),
  /** Three offers expired in a row: reception should call. */
  unresponsive: z.boolean(),
  consecutiveExpired: z.int(),
  source: z.enum(WAITLIST_ENTRY_SOURCES),
  createdAt: Instant,
  /** The offer in flight right now, if any. */
  openOffer: WaitlistOfferDto.nullable(),
});
export type WaitlistEntryDto = z.infer<typeof WaitlistEntryDto>;

export const WaitlistListResponse = z.strictObject({
  entries: z.array(WaitlistEntryDto),
});
export type WaitlistListResponse = z.infer<typeof WaitlistListResponse>;

/** One entry with the offers it received, newest first. */
export const WaitlistEntryDetailResponse = z.strictObject({
  entry: WaitlistEntryDto,
  offers: z.array(WaitlistOfferDto),
});
export type WaitlistEntryDetailResponse = z.infer<typeof WaitlistEntryDetailResponse>;

/** A freed slot reception can fill by phone, with the patient to call. */
export const WaitlistCallItemDto = z.strictObject({
  worklistItemId: Id,
  reason: z.enum(WAITLIST_CALL_REASONS),
  entry: WaitlistEntryDto,
  /** How to reach the patient: administrative contact data of the record. */
  contact: z.strictObject({ phone: z.string().nullable(), email: z.string().nullable() }),
  slot: z.strictObject({
    startsAt: Instant,
    endsAt: Instant,
    professionalId: Id,
    professionalName: z.string(),
    locationId: Id,
    locationName: z.string(),
    timeZone: z.string(),
  }),
});
export type WaitlistCallItemDto = z.infer<typeof WaitlistCallItemDto>;

export const WaitlistCallListResponse = z.strictObject({
  /** The slots still ahead with the entries to call, soonest first. */
  items: z.array(WaitlistCallItemDto),
  /** The entries that let three offers expire in a row. */
  unresponsive: z.array(WaitlistEntryDto),
});
export type WaitlistCallListResponse = z.infer<typeof WaitlistCallListResponse>;

// Public: joining the waitlist -----------------------------------------------------------------

const PersonName = z.string().trim().min(1).max(80);
const Phone = z
  .string()
  .trim()
  .max(30)
  .regex(/^[0-9+()\-\s.]*$/, 'digits and phone punctuation only');

/**
 * The form of a public join (waitlist, "Joining the waitlist"): who the visitor is, what they wait
 * for and when they can come. The agreement to receive offers and the data-processing consent are
 * checked by the API, which answers a missing one with a field error the page can show. The input
 * is not strict: a field the page does not define is dropped.
 */
export const PublicWaitlistJoinRequest = z.object({
  /** The slug of the professional's own booking link. */
  professional: z.string().min(1).max(64),
  appointmentTypeId: Id,
  locationId: Id.optional(),
  ...preferenceFields,
  givenNames: PersonName,
  familyName: PersonName,
  document: DocumentInput,
  birthDate: z.iso.date(),
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  /** Needed only to receive offers on WhatsApp. */
  phone: Phone.optional(),
  channels: z.array(z.enum(WAITLIST_CHANNELS)).min(1).max(2).default(['email']),
  offersOptIn: z.boolean(),
  dataProcessingConsent: z.boolean(),
  challengeProof: z.string().min(1).max(512),
});
export type PublicWaitlistJoinRequest = z.infer<typeof PublicWaitlistJoinRequest>;

export const PublicWaitlistJoinResponse = z.strictObject({
  /** What the next two requests name (the code and the resend). */
  id: Id,
  /** The address the code went to, hidden in part. */
  maskedEmail: z.string(),
  codeExpiresAt: Instant,
});
export type PublicWaitlistJoinResponse = z.infer<typeof PublicWaitlistJoinResponse>;

export const PublicWaitlistConfirmRequest = z.object({ code: z.string().regex(/^\d{6}$/) });
export type PublicWaitlistConfirmRequest = z.infer<typeof PublicWaitlistConfirmRequest>;

/** The same answer for a new patient and for one who already existed. */
export const PublicWaitlistJoinedResponse = z.strictObject({
  joined: z.literal(true),
  /** Until when the entry stays on the list. */
  expiresAt: Instant,
});
export type PublicWaitlistJoinedResponse = z.infer<typeof PublicWaitlistJoinedResponse>;

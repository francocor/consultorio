import { z } from 'zod';

import { WeeklyInterval } from './staff.js';

/**
 * Contracts of the scheduling configuration: appointment types, blocks, days off and the working
 * hours that apply to a range of dates. The tenant is never a field (it comes from the session).
 * Times of a block are absolute instants with an offset; days are calendar dates read in the time
 * zone of the location they belong to.
 */

export const APPOINTMENT_MODES = ['in_person', 'virtual'] as const;
export type AppointmentMode = (typeof APPOINTMENT_MODES)[number];

const Name = z.string().trim().min(1).max(80);
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB');
const Instant = z.iso.datetime({ offset: true });

// Appointment types ---------------------------------------------------------------------------

const AppointmentTypeFields = {
  name: Name,
  description: z.string().trim().max(300).nullable(),
  /** Greater than zero, as scheduling requires; a day is the longest a visit can be. */
  durationMinutes: z.number().int().min(1).max(1440),
  bufferMinutes: z.number().int().min(0).max(1440),
  mode: z.enum(APPOINTMENT_MODES),
  priceReference: z.string().trim().min(1).max(64).nullable(),
  /** The generic wording an invoice shows for the service; absent, the invoice shows the name. */
  invoiceDescription: z.string().trim().min(1).max(120).nullable(),
  requiresApproval: z.boolean(),
  color: Color.nullable(),
  professionalIds: z.array(z.uuid()).max(50),
  specialties: z.array(z.string().trim().min(1).max(60)).max(20),
};

export const CreateAppointmentTypeRequest = z.strictObject({
  name: AppointmentTypeFields.name,
  description: AppointmentTypeFields.description.optional(),
  durationMinutes: AppointmentTypeFields.durationMinutes,
  bufferMinutes: AppointmentTypeFields.bufferMinutes.default(0),
  mode: AppointmentTypeFields.mode,
  priceReference: AppointmentTypeFields.priceReference.optional(),
  invoiceDescription: AppointmentTypeFields.invoiceDescription.optional(),
  requiresApproval: AppointmentTypeFields.requiresApproval.default(false),
  color: AppointmentTypeFields.color.optional(),
  professionalIds: AppointmentTypeFields.professionalIds.default([]),
  specialties: AppointmentTypeFields.specialties.default([]),
});
export type CreateAppointmentTypeRequest = z.infer<typeof CreateAppointmentTypeRequest>;

/** Any subset of the fields; deactivation has its own action. */
export const UpdateAppointmentTypeRequest = z
  .strictObject({
    name: AppointmentTypeFields.name,
    description: AppointmentTypeFields.description,
    durationMinutes: AppointmentTypeFields.durationMinutes,
    bufferMinutes: AppointmentTypeFields.bufferMinutes,
    mode: AppointmentTypeFields.mode,
    priceReference: AppointmentTypeFields.priceReference,
    invoiceDescription: AppointmentTypeFields.invoiceDescription,
    requiresApproval: AppointmentTypeFields.requiresApproval,
    color: AppointmentTypeFields.color,
    professionalIds: AppointmentTypeFields.professionalIds,
    specialties: AppointmentTypeFields.specialties,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'at least one field to change');
export type UpdateAppointmentTypeRequest = z.infer<typeof UpdateAppointmentTypeRequest>;

export const AppointmentTypeDto = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  durationMinutes: z.number().int(),
  bufferMinutes: z.number().int(),
  mode: z.enum(APPOINTMENT_MODES),
  priceReference: z.string().nullable(),
  invoiceDescription: z.string().nullable(),
  requiresApproval: z.boolean(),
  color: z.string().nullable(),
  professionalIds: z.array(z.uuid()),
  specialties: z.array(z.string()),
  active: z.boolean(),
});
export type AppointmentTypeDto = z.infer<typeof AppointmentTypeDto>;

export const AppointmentTypeListResponse = z.strictObject({
  types: z.array(AppointmentTypeDto),
});
export type AppointmentTypeListResponse = z.infer<typeof AppointmentTypeListResponse>;

// Blocks --------------------------------------------------------------------------------------

/** The longest single block, in days. A longer absence is several blocks. */
export const MAX_BLOCK_DAYS = 400;
const DAY_MS = 86_400_000;

export const BlockRecurrence = z
  .strictObject({
    frequency: z.literal('weekly'),
    /** Total number of occurrences, the first included. */
    count: z.number().int().min(2).max(104).optional(),
    /** The last date (a calendar date in the location's zone) an occurrence may start on. */
    until: z.iso.date().optional(),
  })
  .refine((value) => (value.count === undefined) !== (value.until === undefined), {
    message: 'give either a count or an end date',
  });
export type BlockRecurrence = z.infer<typeof BlockRecurrence>;

export const CreateBlockRequest = z
  .strictObject({
    professionalId: z.uuid().optional(),
    locationId: z.uuid().optional(),
    startsAt: Instant,
    endsAt: Instant,
    reason: z.string().trim().min(1).max(200),
    recurrence: BlockRecurrence.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.professionalId === undefined && value.locationId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['professionalId'], message: 'name who is blocked' });
    }
    const start = Date.parse(value.startsAt);
    const end = Date.parse(value.endsAt);
    if (!(end > start)) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'must be after the start' });
    } else if (end - start > MAX_BLOCK_DAYS * DAY_MS) {
      ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'block is too long' });
    }
  });
export type CreateBlockRequest = z.infer<typeof CreateBlockRequest>;

export const BlockDto = z.strictObject({
  id: z.uuid(),
  professionalId: z.uuid().nullable(),
  locationId: z.uuid().nullable(),
  startsAt: Instant,
  endsAt: Instant,
  reason: z.string(),
  seriesId: z.uuid().nullable(),
});
export type BlockDto = z.infer<typeof BlockDto>;

export const BlockListQuery = z.strictObject({
  from: Instant.optional(),
  to: Instant.optional(),
  professionalId: z.uuid().optional(),
  locationId: z.uuid().optional(),
});
export type BlockListQuery = z.infer<typeof BlockListQuery>;

export const BlockListResponse = z.strictObject({ blocks: z.array(BlockDto) });
export type BlockListResponse = z.infer<typeof BlockListResponse>;

// Days off ------------------------------------------------------------------------------------

export const CreateDayOffRequest = z.strictObject({
  day: z.iso.date(),
  name: Name,
  /** Omit for the whole organization. */
  locationId: z.uuid().optional(),
});
export type CreateDayOffRequest = z.infer<typeof CreateDayOffRequest>;

export const DayOffDto = z.strictObject({
  id: z.uuid(),
  day: z.iso.date(),
  name: z.string(),
  locationId: z.uuid().nullable(),
});
export type DayOffDto = z.infer<typeof DayOffDto>;

export const DayOffListQuery = z.strictObject({
  year: z.coerce.number().int().min(2000).max(2100),
});
export type DayOffListQuery = z.infer<typeof DayOffListQuery>;

export const DayOffListResponse = z.strictObject({ daysOff: z.array(DayOffDto) });
export type DayOffListResponse = z.infer<typeof DayOffListResponse>;

/** One calendar day of a year, as the merged holiday calendar reports it. */
export const HolidayDto = z.strictObject({
  day: z.iso.date(),
  name: z.string(),
  source: z.enum(['national', 'bridge', 'organization']),
  /** Only an organization day off may be limited to a location. */
  locationId: z.uuid().nullable(),
  dayOffId: z.uuid().nullable(),
});
export type HolidayDto = z.infer<typeof HolidayDto>;

export const HolidayListResponse = z.strictObject({
  year: z.number().int(),
  holidays: z.array(HolidayDto),
});
export type HolidayListResponse = z.infer<typeof HolidayListResponse>;

// Working hours for a range of dates ----------------------------------------------------------

const MAX_PERIOD_DAYS = 366;

/**
 * Hours that replace the weekly default for a range of dates. An empty list means the
 * professional does not work in the range.
 */
export const SetHoursPeriodRequest = z
  .strictObject({
    dateFrom: z.iso.date(),
    dateTo: z.iso.date(),
    reason: z.string().trim().max(200).optional(),
    hours: z.array(WeeklyInterval).max(200),
  })
  .superRefine((value, ctx) => {
    const from = Date.parse(`${value.dateFrom}T00:00:00Z`);
    const to = Date.parse(`${value.dateTo}T00:00:00Z`);
    if (to < from) {
      ctx.addIssue({ code: 'custom', path: ['dateTo'], message: 'must not be before the start' });
    } else if ((to - from) / DAY_MS + 1 > MAX_PERIOD_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['dateTo'], message: 'a period is at most a year' });
    }
  });
export type SetHoursPeriodRequest = z.infer<typeof SetHoursPeriodRequest>;

export const HoursPeriodDto = z.strictObject({
  id: z.uuid(),
  professionalId: z.uuid(),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  reason: z.string().nullable(),
  hours: z.array(WeeklyInterval),
});
export type HoursPeriodDto = z.infer<typeof HoursPeriodDto>;

export const HoursPeriodListResponse = z.strictObject({ periods: z.array(HoursPeriodDto) });
export type HoursPeriodListResponse = z.infer<typeof HoursPeriodListResponse>;

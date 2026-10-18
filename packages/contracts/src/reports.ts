import { z } from 'zod';

import { APPOINTMENT_SOURCES, APPOINTMENT_STATUSES } from './scheduling.js';

export { REPORTS_ERRORS, REPORTS_AUDIT_ACTIONS } from './reports-catalog.js';

/**
 * Contracts of the reports module (operational, financial and cash reports). The filter and
 * response shapes of the operational report (S4.06) are here; the financial and cash shapes
 * (S4.14) join them below. The export formats are `EXPORT_FORMATS` in `billing.ts`.
 *
 * Nothing in these shapes can carry clinical content: counts, ratios, names of places and people
 * who work there, and, in a drill-down row, the identification of the patient. The organization is
 * never a field; it comes from the session.
 */

/** A report covers at most this many days; a longer range is rejected with a clear message. */
export const REPORT_MAX_SPAN_DAYS = 366;

const Id = z.uuid();
const Instant = z.iso.datetime({ offset: true });
const Count = z.number().int().min(0);
/** A ratio in basis points (1200 is 12.00%); null when there is nothing to divide. */
const RateBp = z.number().int().min(0).nullable();

/** Who a report was cut for: the whole organization, the locations of the viewer, or one professional. */
export const REPORT_SCOPES = ['organization', 'locations', 'professional'] as const;
export type ReportScopeKind = (typeof REPORT_SCOPES)[number];

// Filters ----------------------------------------------------------------------------------------

/**
 * The filters of a report. `from` and `to` are calendar days (both included) read in the time zone
 * of each location, so a day ends when it ends where the appointment is. Unknown members of the
 * query (an organization id, for example) are ignored, never trusted. The order of the range and
 * its span are checked by the module, which answers with a message per field.
 */
export const ReportFilters = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: Id.optional(),
  professionalId: Id.optional(),
  specialty: z.string().trim().min(1).max(80).optional(),
});
export type ReportFilters = z.infer<typeof ReportFilters>;

/** The groups a drill-down can list: every appointment, one status, or one derived figure. */
export const REPORT_GROUPS = [
  'all',
  ...APPOINTMENT_STATUSES,
  'rescheduled',
  'online',
  'recovered',
] as const;
export type ReportGroup = (typeof REPORT_GROUPS)[number];

export const ReportRecordsQuery = ReportFilters.extend({
  group: z.enum(REPORT_GROUPS).default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ReportRecordsQuery = z.infer<typeof ReportRecordsQuery>;

/** The filters as the server applied them, so a screen and an export can show what they cover. */
export const AppliedReportFilters = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: Id.nullable(),
  professionalId: Id.nullable(),
  specialty: z.string().nullable(),
  scope: z.enum(REPORT_SCOPES),
});
export type AppliedReportFilters = z.infer<typeof AppliedReportFilters>;

// Options ----------------------------------------------------------------------------------------

export const ReportOptionsResponse = z.strictObject({
  scope: z.enum(REPORT_SCOPES),
  locations: z.array(z.strictObject({ id: Id, name: z.string() })),
  professionals: z.array(z.strictObject({ id: Id, name: z.string() })),
  specialties: z.array(z.string()),
  /** Owner and admin only: reception never sees revenue by professional, a professional sees their own. */
  canSeeRevenueByProfessional: z.boolean(),
  maxSpanDays: z.number().int().min(1),
});
export type ReportOptionsResponse = z.infer<typeof ReportOptionsResponse>;

// Operational report -----------------------------------------------------------------------------

const StatusCounts = z.record(z.enum(APPOINTMENT_STATUSES), Count);

/** The attendance figures every breakdown row carries. */
const BreakdownFigures = {
  total: Count,
  attended: Count,
  noShow: Count,
  cancelled: Count,
  /** no-show / (attended + no-show) for this row; cancellations and open appointments excluded. */
  noShowRateBp: RateBp,
};

export const OperationalReportResponse = z.strictObject({
  filters: AppliedReportFilters,
  generatedAt: Instant,
  totalAppointments: Count,
  /** The eight statuses of scheduling, as stored. "Rescheduled" is not one of them. */
  byStatus: StatusCounts,
  noShow: z.strictObject({
    attended: Count,
    noShow: Count,
    rateBp: RateBp,
    /** What the rate leaves out, and how much of it (D9). */
    excluded: z.strictObject({
      cancelled: Count,
      /** Appointments not yet in a final attendance state (any time). */
      notFinal: Count,
      /** The part of those that already should have happened: they still need a status. */
      notFinalPast: Count,
    }),
  }),
  occupancy: z.strictObject({
    /** Minutes of appointments that were booked and not cancelled. */
    bookedMinutes: Count,
    /** Minutes of working hours, minus blocks and closed days, times the capacity of each professional. */
    availableMinutes: Count,
    rateBp: RateBp,
  }),
  patients: z.strictObject({ new: Count, returning: Count }),
  /** Appointments of the period that were moved at least once, derived from their history. */
  rescheduled: Count,
  sources: z.strictObject({
    staff: Count,
    online: Count,
    waitlistOffer: Count,
    onlineShareBp: RateBp,
  }),
  waitlist: z.strictObject({ recoveredSlots: Count }),
  confirmations: z.strictObject({
    /** Appointments the patient confirmed on their own (a reply or a link), as the history records. */
    confirmedByPatient: Count,
    /** Over the appointments that were not cancelled. */
    rateBp: RateBp,
  }),
  byDay: z.array(z.strictObject({ date: z.iso.date(), ...BreakdownFigures })),
  byLocation: z.array(z.strictObject({ locationId: Id, name: z.string(), ...BreakdownFigures })),
  byProfessional: z.array(
    z.strictObject({ professionalId: Id, name: z.string().nullable(), ...BreakdownFigures }),
  ),
  /** A professional with several specialties counts once in each. */
  bySpecialty: z.array(z.strictObject({ specialty: z.string(), ...BreakdownFigures })),
});
export type OperationalReportResponse = z.infer<typeof OperationalReportResponse>;

// Drill-down -------------------------------------------------------------------------------------

/** One appointment behind a figure: administrative columns and the identification of the patient. */
export const ReportRecordDto = z.strictObject({
  appointmentId: Id,
  startsAt: Instant,
  /** The day at the location, in its time zone. */
  localDate: z.iso.date(),
  status: z.enum(APPOINTMENT_STATUSES),
  source: z.enum(APPOINTMENT_SOURCES),
  rescheduled: z.boolean(),
  patientId: Id,
  patientName: z.string(),
  locationId: Id,
  locationName: z.string(),
  professionalId: Id,
  professionalName: z.string().nullable(),
  appointmentTypeName: z.string(),
});
export type ReportRecordDto = z.infer<typeof ReportRecordDto>;

export const ReportRecordsResponse = z.strictObject({
  filters: AppliedReportFilters,
  group: z.enum(REPORT_GROUPS),
  /** Every record of the group, whatever the page: it equals the figure the group came from. */
  total: Count,
  limit: z.number().int().min(1),
  offset: Count,
  records: z.array(ReportRecordDto),
});
export type ReportRecordsResponse = z.infer<typeof ReportRecordsResponse>;

import { z } from 'zod';

import { CASH_SESSION_STATUSES, PAYMENT_METHODS } from './billing.js';
import { Money } from './money.js';
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
  /** The name is null for a member who has not set how they appear in the directory. */
  professionals: z.array(z.strictObject({ id: Id, name: z.string().nullable() })),
  specialties: z.array(z.string()),
  /** The payers of the organization, for the filter of the financial report. */
  payers: z.array(z.strictObject({ id: Id, name: z.string() })),
  /** Owner and admin only: reception never sees revenue by professional, a professional sees their own. */
  canSeeRevenueByProfessional: z.boolean(),
  /** The cash register report is for the organization and for reception; a professional has none. */
  canSeeCashReport: z.boolean(),
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
  /** The time of day at the location, `HH:mm`. */
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
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

// Financial report -------------------------------------------------------------------------------

/**
 * The filters of the financial report. A period of calendar days, read in the time zone of each
 * location, and the narrowing choices; what the viewer may see is cut by the server. Unknown members
 * of the query (an organization id, a specialty) are ignored, never trusted.
 */
export const FinancialFilters = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: Id.optional(),
  professionalId: Id.optional(),
  /** The payer of the organization's own list (`tenant_payer.id`). */
  tenantPayerId: Id.optional(),
});
export type FinancialFilters = z.infer<typeof FinancialFilters>;

export const AppliedFinancialFilters = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: Id.nullable(),
  professionalId: Id.nullable(),
  tenantPayerId: Id.nullable(),
  scope: z.enum(REPORT_SCOPES),
});
export type AppliedFinancialFilters = z.infer<typeof AppliedFinancialFilters>;

/**
 * One row of a breakdown. A row is a group of the same dimension for every figure, so a table reads
 * across. Every amount is whole cents (`Money`). Each figure keeps the date it is counted by:
 * `charged`, `voided`, `outstanding` and `receivable` by the day of the service, `payments`,
 * `refunds` and `collected` by the day the money moved, and `invoicedNet` by the date on the voucher.
 */
export const FinancialRow = z.strictObject({
  /** The day (`YYYY-MM-DD`), the id of the location, professional or payer, `private`, or the name of the type. */
  key: z.string(),
  /** The name of the location, professional or payer; null where the key says it all. */
  label: z.string().nullable(),
  /** Charges that are not voided: the patient's part and the payer's part. */
  chargedCents: Money,
  /** Voided charges, apart: they never count as charged. */
  voidedCents: Money,
  paymentsCents: Money,
  /** Refunds and corrections: reductions of what was collected. */
  refundsCents: Money,
  /** Payments minus refunds. */
  collectedCents: Money,
  /** What patients still owe on those charges. */
  outstandingCents: Money,
  /** The payer's part of those charges. */
  receivableCents: Money,
  /** Invoices minus credit notes; null where the voucher does not say it (by appointment type). */
  invoicedNetCents: Money.nullable(),
});
export type FinancialRow = z.infer<typeof FinancialRow>;

export const MethodRow = z.strictObject({
  method: z.enum(PAYMENT_METHODS),
  /** Entries: payments and refunds. */
  count: Count,
  paymentsCents: Money,
  refundsCents: Money,
  netCents: Money,
});
export type MethodRow = z.infer<typeof MethodRow>;

export const FinancialReportResponse = z.strictObject({
  filters: AppliedFinancialFilters,
  generatedAt: Instant,
  totals: z.strictObject({
    charged: z.strictObject({
      count: Count,
      totalCents: Money,
      patientCents: Money,
      payerCents: Money,
    }),
    /** Shown apart; never part of `charged`. */
    voided: z.strictObject({ count: Count, totalCents: Money }),
    collected: z.strictObject({
      paymentCount: Count,
      paymentsCents: Money,
      refundCount: Count,
      refundsCents: Money,
      netCents: Money,
    }),
    outstanding: z.strictObject({ chargeCount: Count, cents: Money }),
    receivable: z.strictObject({ cents: Money }),
    /** Issued and registered vouchers only; a credit note is a reduction. */
    invoiced: z.strictObject({
      invoicedCents: Money,
      creditedCents: Money,
      netCents: Money,
      documents: Count,
    }),
  }),
  byMethod: z.array(MethodRow),
  /** One row per day; the screen adds them up by month for a long period. */
  byPeriod: z.array(FinancialRow),
  byLocation: z.array(FinancialRow),
  /** Null when the viewer may not see revenue by professional (reception). */
  byProfessional: z.array(FinancialRow).nullable(),
  byPayer: z.array(FinancialRow),
  byType: z.array(FinancialRow),
});
export type FinancialReportResponse = z.infer<typeof FinancialReportResponse>;

// Financial drill-down ---------------------------------------------------------------------------

/** The figures that can be opened into the records that compose them. */
export const FINANCIAL_RECORD_KINDS = [
  'charged',
  'voided',
  'collected',
  'outstanding',
  'receivable',
  'invoiced',
] as const;
export type FinancialRecordKind = (typeof FINANCIAL_RECORD_KINDS)[number];

export const FinancialRecordsQuery = FinancialFilters.extend({
  kind: z.enum(FINANCIAL_RECORD_KINDS).default('charged'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type FinancialRecordsQuery = z.infer<typeof FinancialRecordsQuery>;

/**
 * One record behind a figure: a charge, a payment or a refund, or a voucher. Identification and
 * money only; never a note, a diagnosis or a prescription.
 */
export const FinancialRecordDto = z.strictObject({
  /** The charge, the payment or refund entry, or the voucher. */
  id: Id,
  /** The day of the service, of the movement, or on the voucher. */
  date: z.iso.date(),
  /** Null on a voucher, which names no patient. */
  patientName: z.string().nullable(),
  locationId: Id,
  locationName: z.string(),
  professionalId: Id,
  professionalName: z.string().nullable(),
  /** Null for a private patient. */
  payerName: z.string().nullable(),
  typeName: z.string().nullable(),
  /** The state of the charge, the movement (`payment`, `refund`, `correction`) or the voucher type. */
  status: z.string(),
  method: z.enum(PAYMENT_METHODS).nullable(),
  /** What the record adds to the figure it was opened from; negative for a refund or a credit note. */
  amountCents: Money,
  /** The whole charge, where the amount is only a part of it; null on a payment or a voucher. */
  chargeTotalCents: Money.nullable(),
});
export type FinancialRecordDto = z.infer<typeof FinancialRecordDto>;

export const FinancialRecordsResponse = z.strictObject({
  filters: AppliedFinancialFilters,
  kind: z.enum(FINANCIAL_RECORD_KINDS),
  /** Every record of the kind, whatever the page. */
  total: Count,
  /** The sum of every record of the kind: it equals the figure the kind was opened from. */
  sumCents: Money,
  limit: z.number().int().min(1),
  offset: Count,
  records: z.array(FinancialRecordDto),
});
export type FinancialRecordsResponse = z.infer<typeof FinancialRecordsResponse>;

// Cash report ------------------------------------------------------------------------------------

export const CashReportFilters = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: Id.optional(),
});
export type CashReportFilters = z.infer<typeof CashReportFilters>;

export const AppliedCashFilters = z.strictObject({
  from: z.iso.date(),
  to: z.iso.date(),
  locationId: Id.nullable(),
  scope: z.enum(REPORT_SCOPES),
});
export type AppliedCashFilters = z.infer<typeof AppliedCashFilters>;

/** One register of a day, with the difference it closed with and the reason that was given. */
export const CashSessionRow = z.strictObject({
  id: Id,
  status: z.enum(CASH_SESSION_STATUSES),
  openedAt: Instant,
  closedAt: Instant.nullable(),
  openingCents: Money,
  /** What a closed register wrote when it closed; what an open one holds now. */
  expectedCents: Money,
  countedCents: Money.nullable(),
  /** Counted minus expected: negative when cash is missing. Null while the register is open. */
  differenceCents: Money.nullable(),
  differenceReason: z.string().nullable(),
});
export type CashSessionRow = z.infer<typeof CashSessionRow>;

/** A location and a day (the day the register was opened, at the clock of the location). */
export const CashDayRow = z.strictObject({
  date: z.iso.date(),
  locationId: Id,
  locationName: z.string(),
  openingCents: Money,
  /** Money received by every method, and refunds, in the registers of the day. */
  paymentsCents: Money,
  refundsCents: Money,
  /** Cash that should be in the drawers: opening plus cash taken minus cash given back. */
  expectedCents: Money,
  /** Counted cash of the closed registers; null when none closed. */
  countedCents: Money.nullable(),
  /** The sum of the differences of the closed registers; null when none closed. */
  differenceCents: Money.nullable(),
  openSessions: Count,
  closedSessions: Count,
  byMethod: z.array(MethodRow),
  sessions: z.array(CashSessionRow),
});
export type CashDayRow = z.infer<typeof CashDayRow>;

export const CashReportResponse = z.strictObject({
  filters: AppliedCashFilters,
  generatedAt: Instant,
  totals: z.strictObject({
    openingCents: Money,
    paymentsCents: Money,
    refundsCents: Money,
    expectedCents: Money,
    countedCents: Money.nullable(),
    differenceCents: Money.nullable(),
    /** Days with a register that closed with a difference. */
    daysWithDifference: Count,
    byMethod: z.array(MethodRow),
  }),
  days: z.array(CashDayRow),
});
export type CashReportResponse = z.infer<typeof CashReportResponse>;

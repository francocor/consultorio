import { z } from 'zod';

import { MONEY_ZERO } from './money.js';

export { BILLING_ERRORS, BILLING_AUDIT_ACTIONS } from './billing-catalog.js';

/**
 * Contracts of the billing module (prices, charges, payments, the cash register, exports). This
 * file holds what is certain from the design and the spec; the billing track (S4.01 to S4.05) adds
 * its request and response shapes below, in this file only. Every amount is `Money` (whole cents).
 */

export const CHARGE_STATUSES = ['pending', 'partially_paid', 'paid', 'voided'] as const;
export type ChargeStatus = (typeof CHARGE_STATUSES)[number];

/** Who owes a line: the patient (copago, plus, private price) or the payer (obra social, prepaga). */
export const CHARGE_LINE_PORTIONS = ['patient', 'payer'] as const;
export type ChargeLinePortion = (typeof CHARGE_LINE_PORTIONS)[number];

/**
 * What a charge line is: the price of the service (private), the part the payer covers, the
 * copago and the plus the patient adds, an explicit late-cancellation or no-show fee, or a line a
 * person added by hand.
 */
export const CHARGE_LINE_KINDS = [
  'service',
  'payer_coverage',
  'copago',
  'plus',
  'late_fee',
  'manual',
] as const;
export type ChargeLineKind = (typeof CHARGE_LINE_KINDS)[number];

/** Why a charge is flagged for a person to look at: the appointment ended without the service. */
export const CHARGE_REVIEW_REASONS = ['no_show', 'cancelled'] as const;
export type ChargeReviewReason = (typeof CHARGE_REVIEW_REASONS)[number];

export const PAYMENT_METHODS = [
  'cash',
  'debit',
  'credit',
  'transfer',
  'wallet',
  'payment_link',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * The formats of an export (billing exports and reports share one export job). The report screens
 * import this list from here.
 */
export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The `billing` section of the organization settings. */
export const BillingSettings = z.strictObject({
  /** Adds an explicit fee line to a late cancellation or a no-show. */
  lateFeeEnabled: z.boolean(),
  /** The fee, in cents of ARS. Meaningful only while `lateFeeEnabled` is on. */
  lateFeeAmount: z.int().min(0).max(100_000_000).brand<'MoneyCents'>(),
});
export type BillingSettings = z.infer<typeof BillingSettings>;

export const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  lateFeeEnabled: false,
  lateFeeAmount: MONEY_ZERO,
};

// Amounts -------------------------------------------------------------------------------------

/** The most one price, charge line or payment may hold: 10,000,000 pesos, in cents. */
export const MAX_AMOUNT_CENTS = 1_000_000_000;

/** An amount above zero: a price, a charge line, a payment. */
export const PositiveMoney = z.int().min(1).max(MAX_AMOUNT_CENTS).brand<'MoneyCents'>();
export type PositiveMoney = z.infer<typeof PositiveMoney>;

/** A part that may be zero: the copago, the plus, what the payer covers. */
export const PartMoney = z.int().min(0).max(MAX_AMOUNT_CENTS).brand<'MoneyCents'>();
export type PartMoney = z.infer<typeof PartMoney>;

/** An amount in a response: whole cents, signed (a difference at the cash register can be negative). */
const Cents = z.int().brand<'MoneyCents'>();

const IsoDay = z.iso.date();
const Specialty = z.string().trim().min(1).max(60);
const PlanName = z.string().trim().min(1).max(80);

// Payers --------------------------------------------------------------------------------------

export const BILLING_PAYER_KINDS = ['obra_social', 'prepaga', 'private', 'custom'] as const;
export type BillingPayerKind = (typeof BILLING_PAYER_KINDS)[number];

/** A payer the organization bills (billing-payments, "Payer and plan catalog with coverage pricing"). */
export const TenantPayerDto = z.strictObject({
  id: z.uuid(),
  /** The payer of the platform catalog it was copied from; null for a custom one. */
  payerId: z.uuid().nullable(),
  name: z.string(),
  kind: z.enum(BILLING_PAYER_KINDS),
  active: z.boolean(),
  deactivatedAt: z.iso.datetime().nullable(),
});
export type TenantPayerDto = z.infer<typeof TenantPayerDto>;

/** A payer of the catalog of the country that the organization has not copied yet. */
export const PayerOptionDto = z.strictObject({
  payerId: z.uuid(),
  name: z.string(),
  kind: z.enum(['obra_social', 'prepaga', 'private']),
});
export type PayerOptionDto = z.infer<typeof PayerOptionDto>;

export const PayerListResponse = z.strictObject({
  payers: z.array(TenantPayerDto),
  /** What can still be copied from the platform catalog. */
  available: z.array(PayerOptionDto),
});
export type PayerListResponse = z.infer<typeof PayerListResponse>;

/** Copy a payer of the catalog, or add one of the organization's own. Exactly one of the two. */
export const CreateTenantPayerRequest = z.union([
  z.strictObject({ payerId: z.uuid() }),
  z.strictObject({ customName: z.string().trim().min(2).max(80) }),
]);
export type CreateTenantPayerRequest = z.infer<typeof CreateTenantPayerRequest>;

export const UpdateTenantPayerRequest = z.strictObject({ active: z.boolean() });
export type UpdateTenantPayerRequest = z.infer<typeof UpdateTenantPayerRequest>;

// Prices --------------------------------------------------------------------------------------

/** A private price of an appointment type, from a day. Narrower scopes win (see `price-resolution`). */
export const PriceDto = z.strictObject({
  id: z.uuid(),
  appointmentTypeId: z.uuid(),
  appointmentTypeName: z.string(),
  professionalId: z.uuid().nullable(),
  professionalName: z.string().nullable(),
  specialty: z.string().nullable(),
  locationId: z.uuid().nullable(),
  locationName: z.string().nullable(),
  amountCents: Cents,
  effectiveFrom: IsoDay,
  active: z.boolean(),
});
export type PriceDto = z.infer<typeof PriceDto>;

export const CreatePriceRequest = z.strictObject({
  appointmentTypeId: z.uuid(),
  professionalId: z.uuid().optional(),
  specialty: Specialty.optional(),
  locationId: z.uuid().optional(),
  amountCents: PositiveMoney,
  effectiveFrom: IsoDay,
});
export type CreatePriceRequest = z.infer<typeof CreatePriceRequest>;

/** A price is corrected or switched off; a new date is a new price, so the history stays. */
export const UpdatePriceRequest = z
  .strictObject({ amountCents: PositiveMoney.optional(), active: z.boolean().optional() })
  .refine((value) => value.amountCents !== undefined || value.active !== undefined, {
    message: 'nothing to change',
  });
export type UpdatePriceRequest = z.infer<typeof UpdatePriceRequest>;

/** What a payer plan pays for a type, and what the patient adds (copago and plus). */
export const PayerPriceDto = z.strictObject({
  id: z.uuid(),
  tenantPayerId: z.uuid(),
  payerName: z.string(),
  planName: z.string().nullable(),
  appointmentTypeId: z.uuid(),
  appointmentTypeName: z.string(),
  payerAmountCents: Cents,
  copagoCents: Cents,
  plusCents: Cents,
  effectiveFrom: IsoDay,
  active: z.boolean(),
});
export type PayerPriceDto = z.infer<typeof PayerPriceDto>;

const PayerPriceParts = {
  payerAmountCents: PartMoney,
  copagoCents: PartMoney,
  plusCents: PartMoney,
};

const hasSomethingToPay = (value: {
  payerAmountCents: number;
  copagoCents: number;
  plusCents: number;
}) => value.payerAmountCents + value.copagoCents + value.plusCents > 0;

export const CreatePayerPriceRequest = z
  .strictObject({
    tenantPayerId: z.uuid(),
    appointmentTypeId: z.uuid(),
    planName: PlanName.optional(),
    ...PayerPriceParts,
    effectiveFrom: IsoDay,
  })
  .refine(hasSomethingToPay, { message: 'the price adds up to nothing' });
export type CreatePayerPriceRequest = z.infer<typeof CreatePayerPriceRequest>;

export const UpdatePayerPriceRequest = z
  .strictObject({
    payerAmountCents: PartMoney.optional(),
    copagoCents: PartMoney.optional(),
    plusCents: PartMoney.optional(),
    active: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.payerAmountCents !== undefined ||
      value.copagoCents !== undefined ||
      value.plusCents !== undefined ||
      value.active !== undefined,
    { message: 'nothing to change' },
  );
export type UpdatePayerPriceRequest = z.infer<typeof UpdatePayerPriceRequest>;

export const PriceListResponse = z.strictObject({
  prices: z.array(PriceDto),
  payerPrices: z.array(PayerPriceDto),
});
export type PriceListResponse = z.infer<typeof PriceListResponse>;

// Quotes --------------------------------------------------------------------------------------

export const QUOTE_LINE_KINDS = ['service', 'payer_coverage', 'copago', 'plus'] as const;
export type QuoteLineKind = (typeof QUOTE_LINE_KINDS)[number];

export const QUOTE_REASONS = ['payer_inactive', 'payer_without_price', 'payer_not_listed'] as const;
export type QuoteReason = (typeof QUOTE_REASONS)[number];

export const QuoteLineDto = z.strictObject({
  kind: z.enum(QUOTE_LINE_KINDS),
  portion: z.enum(CHARGE_LINE_PORTIONS),
  amountCents: Cents,
});
export type QuoteLineDto = z.infer<typeof QuoteLineDto>;

export const QuoteDto = z.strictObject({
  source: z.enum(['private', 'payer']),
  priceId: z.uuid().nullable(),
  payerPriceId: z.uuid().nullable(),
  /** The payer the quote is for; null for a private price. */
  payer: z
    .strictObject({ tenantPayerId: z.uuid(), name: z.string(), planName: z.string().nullable() })
    .nullable(),
  effectiveFrom: IsoDay,
  lines: z.array(QuoteLineDto),
  totalCents: Cents,
  patientCents: Cents,
  payerCents: Cents,
  /** Why a private price was used for a patient who has a payer. */
  reasons: z.array(z.enum(QUOTE_REASONS)),
});
export type QuoteDto = z.infer<typeof QuoteDto>;

/** The payer to quote with: the coverage of the patient (omitted), the private price, or a payer. */
export const PriceQuoteQuery = z.strictObject({
  appointmentId: z.uuid(),
  payer: z.union([z.literal('private'), z.uuid()]).optional(),
  planName: PlanName.optional(),
});
export type PriceQuoteQuery = z.infer<typeof PriceQuoteQuery>;

export const PriceQuoteResponse = z.strictObject({
  appointmentId: z.uuid(),
  appointmentTypeName: z.string(),
  /** Null when no price matches: the charge then needs an amount typed by a person. */
  quote: QuoteDto.nullable(),
});
export type PriceQuoteResponse = z.infer<typeof PriceQuoteResponse>;

// Charges -------------------------------------------------------------------------------------

const ReasonText = z.string().trim().min(3).max(200);

/**
 * Charges an appointment. The price comes from the catalog (the same quote the desk saw); when
 * nothing prices the service, a person types the amount (`explicitAmountCents`) and the capture is
 * audited as an override. `payer` picks the private price or a payer of the list by hand; omitted,
 * the coverage of the patient decides.
 */
export const CaptureChargeRequest = z.strictObject({
  appointmentId: z.uuid(),
  payer: z.union([z.literal('private'), z.uuid()]).optional(),
  planName: PlanName.optional(),
  explicitAmountCents: PositiveMoney.optional(),
});
export type CaptureChargeRequest = z.infer<typeof CaptureChargeRequest>;

/** A line a person adds to a charge that exists (material, a study, an adjustment owed). */
export const AddChargeLineRequest = z.strictObject({
  description: z.string().trim().min(1).max(200),
  amountCents: PositiveMoney,
  portion: z.enum(CHARGE_LINE_PORTIONS).optional(),
});
export type AddChargeLineRequest = z.infer<typeof AddChargeLineRequest>;

export const VoidChargeRequest = z.strictObject({ reason: ReasonText });
export type VoidChargeRequest = z.infer<typeof VoidChargeRequest>;

/** `true` / `false` in a query string. */
const QueryFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const ChargeListQuery = z.strictObject({
  status: z.enum(CHARGE_STATUSES).optional(),
  patientId: z.uuid().optional(),
  appointmentId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  professionalId: z.uuid().optional(),
  /** The first and last day of the service (the appointment), inclusive. */
  from: IsoDay.optional(),
  to: IsoDay.optional(),
  needsReview: QueryFlag.optional(),
});
export type ChargeListQuery = z.infer<typeof ChargeListQuery>;

export const ChargeLineDto = z.strictObject({
  id: z.uuid(),
  position: z.int().min(1),
  kind: z.enum(CHARGE_LINE_KINDS),
  portion: z.enum(CHARGE_LINE_PORTIONS),
  description: z.string(),
  amountCents: Cents,
  /** How much of the line invoices cover so far (the invoicing module moves it). */
  invoicedCents: Cents,
});
export type ChargeLineDto = z.infer<typeof ChargeLineDto>;

/** The figures a charge applied when it was made. Changing a price never changes them. */
export const ChargeSnapshotDto = z.strictObject({
  quote: QuoteDto.nullable(),
  /** The amount a person typed when nothing priced the service. */
  explicitAmountCents: Cents.nullable(),
  appointmentTypeName: z.string(),
  /** The day of the service, in the time zone of the location. */
  serviceDate: IsoDay,
});
export type ChargeSnapshotDto = z.infer<typeof ChargeSnapshotDto>;

/** Where invoicing stands, derived from the lines; it is not a state of the charge. */
export const CHARGE_INVOICING_POSITIONS = ['not_invoiced', 'partly_invoiced', 'invoiced'] as const;
export type ChargeInvoicingPosition = (typeof CHARGE_INVOICING_POSITIONS)[number];

/**
 * A charge as the screens and the invoicing module read it. Administrative data only: names, the
 * appointment, amounts and states. Nothing clinical is ever part of it.
 */
export const ChargeDto = z.strictObject({
  id: z.uuid(),
  appointmentId: z.uuid(),
  appointmentTypeName: z.string(),
  startsAt: z.iso.datetime(),
  patientId: z.uuid(),
  patientName: z.string(),
  professionalId: z.uuid(),
  professionalName: z.string(),
  locationId: z.uuid(),
  locationName: z.string(),
  /** The payer the charge was made for; null for a private patient. */
  tenantPayerId: z.uuid().nullable(),
  payerName: z.string().nullable(),
  planName: z.string().nullable(),
  status: z.enum(CHARGE_STATUSES),
  explicitAmount: z.boolean(),
  needsReview: z.boolean(),
  reviewReason: z.enum(CHARGE_REVIEW_REASONS).nullable(),
  flaggedAt: z.iso.datetime().nullable(),
  voidReason: z.string().nullable(),
  voidedAt: z.iso.datetime().nullable(),
  lines: z.array(ChargeLineDto),
  /** Everything the charge adds up to, what the patient owes and what the payer owes. */
  totalCents: Cents,
  patientCents: Cents,
  payerCents: Cents,
  /** What the patient has paid, net of refunds. */
  paidCents: Cents,
  /** What the patient still owes of their portion (never below zero). */
  outstandingCents: Cents,
  /** What the patient paid above their portion and a person confirmed as a credit balance. */
  creditCents: Cents,
  invoicedCents: Cents,
  invoicing: z.enum(CHARGE_INVOICING_POSITIONS),
  snapshot: ChargeSnapshotDto,
  capturedBy: z.uuid(),
  capturedAt: z.iso.datetime(),
});
export type ChargeDto = z.infer<typeof ChargeDto>;

export const ChargeListResponse = z.strictObject({ charges: z.array(ChargeDto) });
export type ChargeListResponse = z.infer<typeof ChargeListResponse>;

/** An appointment that already has a charge answers with it (the 409 of a double capture). */
export const ChargeExistsExtension = z.object({ existingChargeId: z.uuid() });
export type ChargeExistsExtension = z.infer<typeof ChargeExistsExtension>;

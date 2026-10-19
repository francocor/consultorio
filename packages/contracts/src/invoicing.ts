import { z } from 'zod';

export { INVOICING_ERRORS, INVOICING_AUDIT_ACTIONS } from './invoicing-catalog.js';

/**
 * Contracts of the invoicing module (fiscal configuration, AFIP invoices, credit notes). This file
 * holds what is certain from the design and the spec; the invoicing track (S4.08 to S4.13) adds its
 * request and response shapes below, in this file only. The port the issuers implement
 * (`InvoiceIssuer`, `InvoiceRequest`, `IssueResult`) is in `ports.ts`.
 */

/** There is no "voided" state: a correction of an issued invoice is a credit note. */
export const INVOICE_STATUSES = ['pending', 'issued', 'rejected', 'manual'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * The internal sub-state of a PENDING invoice. It is never shown or reported as a state of the
 * invoice: the screens show "pending" and, past the threshold, a flag computed from its age.
 *
 * - `awaiting_reconciliation`: the request may have reached the authority and its answer is not
 *   known (the mark is written BEFORE the call and cleared by a definite answer).
 * - `needs_attention`: the authority answered with a voucher that cannot be recorded (its number is
 *   already one of ours). No automatic attempt touches it again; a person decides, from the worklist.
 */
export const INVOICE_DELIVERY_STATES = [
  'queued',
  'retrying',
  'awaiting_reconciliation',
  'needs_attention',
] as const;
export type InvoiceDeliveryState = (typeof INVOICE_DELIVERY_STATES)[number];

/** Voucher types, as the `InvoiceIssuer` port names them: invoices (F) and credit notes (NC) A, B, C. */
export const INVOICE_TYPES = ['FA', 'FB', 'FC', 'NCA', 'NCB', 'NCC'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const TAX_CONDITIONS = ['monotributo', 'responsable_inscripto', 'exento'] as const;
export type TaxCondition = (typeof TAX_CONDITIONS)[number];

/**
 * What a recipient is for the tax authority. It is not the issuer's `TaxCondition`: a recipient may
 * be a consumer who has no registration at all.
 */
export const RECIPIENT_TAX_CONDITIONS = [
  'consumidor_final',
  'responsable_inscripto',
  'monotributo',
  'exento',
] as const;
export type RecipientTaxCondition = (typeof RECIPIENT_TAX_CONDITIONS)[number];

/** The kind of document a recipient is identified with. */
export const RECIPIENT_DOCUMENT_TYPES = ['cuit', 'dni'] as const;
export type RecipientDocumentType = (typeof RECIPIENT_DOCUMENT_TYPES)[number];

/** The environment is a property of the point of sale, not of the organization. */
export const FISCAL_ENVIRONMENTS = ['homologation', 'production'] as const;
export type FiscalEnvironment = (typeof FISCAL_ENVIRONMENTS)[number];

/** The state of the certificate of an organization (`expiring` is under 30 days). */
export const CREDENTIAL_STATES = ['valid', 'expiring', 'expired', 'invalid'] as const;
export type CredentialState = (typeof CREDENTIAL_STATES)[number];

/** What the local AFIP simulator can be told to do (the provider console, `/operator/dev/afip`). */
export const AFIP_SIMULATOR_MODES = [
  'ok',
  'down',
  'slow',
  'timeout_after_authorize',
  'reject_next',
] as const;
export type AfipSimulatorMode = (typeof AFIP_SIMULATOR_MODES)[number];

/** The `invoicing` section of the organization settings. */
export const InvoicingSettings = z.strictObject({
  /** A pending invoice older than this is flagged by its age (it never gets a new state). */
  outageThresholdHours: z.int().min(1).max(720),
});
export type InvoicingSettings = z.infer<typeof InvoicingSettings>;

export const DEFAULT_INVOICING_SETTINGS: InvoicingSettings = { outageThresholdHours: 24 };

// Fiscal configuration (S4.08) --------------------------------------------------------------------

const Text = (max: number) => z.string().trim().min(1).max(max);

/** The fiscal identity of the organization, as the owner enters it. The CUIT keeps any format. */
export const UpsertFiscalProfileRequest = z.strictObject({
  cuit: Text(20),
  taxCondition: z.enum(TAX_CONDITIONS),
  businessName: Text(120),
  address: Text(200),
  activityStartedOn: z.iso.date(),
});
export type UpsertFiscalProfileRequest = z.infer<typeof UpsertFiscalProfileRequest>;

export const FiscalProfileDto = z.strictObject({
  /** Eleven digits. */
  cuit: z.string(),
  taxCondition: z.enum(TAX_CONDITIONS),
  businessName: z.string(),
  address: z.string(),
  activityStartedOn: z.iso.date(),
});
export type FiscalProfileDto = z.infer<typeof FiscalProfileDto>;

export const CreatePointOfSaleRequest = z.strictObject({
  number: z.int().min(1).max(99_999),
  environment: z.enum(FISCAL_ENVIRONMENTS).optional(),
});
export type CreatePointOfSaleRequest = z.infer<typeof CreatePointOfSaleRequest>;

export const UpdatePointOfSaleRequest = z
  .strictObject({
    environment: z.enum(FISCAL_ENVIRONMENTS).optional(),
    active: z.boolean().optional(),
  })
  .refine((value) => value.environment !== undefined || value.active !== undefined, {
    message: 'validation.required',
  });
export type UpdatePointOfSaleRequest = z.infer<typeof UpdatePointOfSaleRequest>;

export const PointOfSaleDto = z.strictObject({
  id: z.uuid(),
  number: z.int(),
  /** What the owner chose for this point of sale. */
  environment: z.enum(FISCAL_ENVIRONMENTS),
  /** What is used: the local simulator forces homologation whatever was chosen. */
  effectiveEnvironment: z.enum(FISCAL_ENVIRONMENTS),
  active: z.boolean(),
});
export type PointOfSaleDto = z.infer<typeof PointOfSaleDto>;

/** The certificate and the key in PEM text. They are never returned by any endpoint. */
export const PutCredentialRequest = z.strictObject({
  certificate: z.string().min(1).max(20_000),
  privateKey: z.string().min(1).max(20_000),
});
export type PutCredentialRequest = z.infer<typeof PutCredentialRequest>;

/** What may be said about the certificate. Neither the certificate nor the key is in here. */
export const CredentialSummaryDto = z.strictObject({
  state: z.enum(CREDENTIAL_STATES),
  notBefore: z.iso.datetime(),
  notAfter: z.iso.datetime(),
  subjectCuit: z.string(),
  fingerprint: z.string(),
  uploadedAt: z.iso.datetime(),
});
export type CredentialSummaryDto = z.infer<typeof CredentialSummaryDto>;

/** Why invoicing is not available. Several can hold at once. */
export const INVOICING_BLOCK_REASONS = [
  'disabled',
  'issuer_unavailable',
  'profile_missing',
  'point_of_sale_missing',
  'credential_missing',
  'credential_expired',
  'credential_invalid',
] as const;
export type InvoicingBlockReason = (typeof INVOICING_BLOCK_REASONS)[number];

export const InvoicingReadinessDto = z.strictObject({
  available: z.boolean(),
  reasons: z.array(z.enum(INVOICING_BLOCK_REASONS)),
  /** True when the invoices of this organization come from a simulator (local or demo). */
  simulated: z.boolean(),
});
export type InvoicingReadinessDto = z.infer<typeof InvoicingReadinessDto>;

export const FiscalConfigResponse = z.strictObject({
  /** `settings.integrations.einvoicing`. */
  enabled: z.boolean(),
  profile: FiscalProfileDto.nullable(),
  pointsOfSale: z.array(PointOfSaleDto),
  credential: CredentialSummaryDto.nullable(),
  readiness: InvoicingReadinessDto,
});
export type FiscalConfigResponse = z.infer<typeof FiscalConfigResponse>;

/**
 * What the person who issues invoices needs to know to fill in the form, without the fiscal
 * configuration (which only the owner and the admin read): the voucher type the rules give for each
 * kind of recipient, so the screen shows it and never offers a choice beyond it, and the points of
 * sale that can be used.
 */
export const InvoicingOptionsDto = z.strictObject({
  taxCondition: z.enum(TAX_CONDITIONS).nullable(),
  /** One entry per recipient condition; empty while there is no fiscal profile. */
  types: z.array(
    z.strictObject({
      recipient: z.enum(RECIPIENT_TAX_CONDITIONS),
      type: z.enum(INVOICE_TYPES),
    }),
  ),
  /** The active ones, with the environment that is really used. */
  pointsOfSale: z.array(
    z.strictObject({ number: z.int(), environment: z.enum(FISCAL_ENVIRONMENTS) }),
  ),
});
export type InvoicingOptionsDto = z.infer<typeof InvoicingOptionsDto>;

// Provider console: the AFIP simulator (S4.09) -----------------------------------------------------

export const AfipSimulatorModeRequest = z.strictObject({ mode: z.enum(AFIP_SIMULATOR_MODES) });
export type AfipSimulatorModeRequest = z.infer<typeof AfipSimulatorModeRequest>;

/** A voucher the simulator authorized, as the console lists it. */
export const AfipSimulatorVoucherDto = z.strictObject({
  id: z.uuid(),
  /** The organization the voucher belongs to (`''`: it predates the reference). */
  tenantRef: z.string(),
  issuerCuit: z.string(),
  pointOfSale: z.int(),
  type: z.string(),
  number: z.int(),
  cae: z.string(),
  caeExpiresOn: z.iso.date(),
  issueDate: z.iso.date(),
  totalCents: z.int(),
  createdAt: z.iso.datetime(),
});
export type AfipSimulatorVoucherDto = z.infer<typeof AfipSimulatorVoucherDto>;

/** The console lists every organization's vouchers, or the ones of one of them. */
export const AfipSimulatorStateQuery = z.strictObject({ tenantRef: z.uuid().optional() });
export type AfipSimulatorStateQuery = z.infer<typeof AfipSimulatorStateQuery>;

export const AfipSimulatorStateResponse = z.strictObject({
  mode: z.enum(AFIP_SIMULATOR_MODES),
  /** The newest first. */
  vouchers: z.array(AfipSimulatorVoucherDto),
});
export type AfipSimulatorStateResponse = z.infer<typeof AfipSimulatorStateResponse>;

// Invoices and credit notes (S4.10 to S4.13) ------------------------------------------------------

/** An invoice is a Factura; a credit note is a Nota de Credito. */
export const INVOICE_KINDS = ['invoice', 'credit_note'] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

/** The types that are invoices (the others are credit notes). */
export const INVOICE_ONLY_TYPES = ['FA', 'FB', 'FC'] as const;
export type InvoiceOnlyType = (typeof INVOICE_ONLY_TYPES)[number];

export const CREDIT_NOTE_TYPES = ['NCA', 'NCB', 'NCC'] as const;
export type CreditNoteType = (typeof CREDIT_NOTE_TYPES)[number];

export function invoiceKindOf(type: InvoiceType): InvoiceKind {
  return CREDIT_NOTE_TYPES.some((note) => note === type) ? 'credit_note' : 'invoice';
}

/** Who the invoice is addressed to: the patient (their own portion) or the payer (its portion). */
export const INVOICE_RECIPIENT_KINDS = ['patient', 'payer'] as const;
export type InvoiceRecipientKind = (typeof INVOICE_RECIPIENT_KINDS)[number];

/** Made by the client for each submission, so a retry of the same one cannot create two invoices. */
const SubmissionKey = z.uuid();
const PositiveCents = z.int().positive();
const PointOfSaleNumber = z.int().min(1).max(99_999);

/**
 * What is known of the person or entity an invoice is addressed to. The payer's name and CUIT come
 * from the payer in the organization's list, the patient's name from the patient; what the person
 * enters is the tax condition, a document where the rules ask for one, and a name to print.
 */
export const InvoiceRecipientInput = z.strictObject({
  kind: z.enum(INVOICE_RECIPIENT_KINDS),
  taxCondition: z.enum(RECIPIENT_TAX_CONDITIONS).optional(),
  name: Text(120).optional(),
  document: z.strictObject({ type: z.enum(RECIPIENT_DOCUMENT_TYPES), number: Text(20) }).optional(),
});
export type InvoiceRecipientInput = z.infer<typeof InvoiceRecipientInput>;

/** A charge line and how much of it the invoice covers (all that is still uninvoiced, if absent). */
export const InvoiceLineInput = z.strictObject({
  chargeLineId: z.uuid(),
  amountCents: PositiveCents.optional(),
});
export type InvoiceLineInput = z.infer<typeof InvoiceLineInput>;

const InvoiceLinesInput = z.array(InvoiceLineInput).min(1).max(50);

export const CreateInvoiceRequest = z.strictObject({
  idempotencyKey: SubmissionKey,
  lines: InvoiceLinesInput,
  recipient: InvoiceRecipientInput,
  /** Only checked against the rules: a type beyond them is refused. Absent: the rules decide. */
  type: z.enum(INVOICE_ONLY_TYPES).optional(),
  /** The number of an active point of sale. Absent: the only active one. */
  pointOfSale: PointOfSaleNumber.optional(),
  /** The rejected attempt this one corrects and retries. */
  previousAttemptId: z.uuid().optional(),
});
export type CreateInvoiceRequest = z.infer<typeof CreateInvoiceRequest>;

export const CreateCreditNoteRequest = z.strictObject({
  idempotencyKey: SubmissionKey,
  reason: z.string().trim().min(3).max(200),
  /** Absent: a total note, for everything of the invoice that is not credited yet. */
  amountCents: PositiveCents.optional(),
});
export type CreateCreditNoteRequest = z.infer<typeof CreateCreditNoteRequest>;

/** An invoice issued outside the system (the AFIP web tool), registered by the owner or an admin. */
export const CreateManualInvoiceRequest = z.strictObject({
  idempotencyKey: SubmissionKey,
  /**
   * An invoice type, or a credit note type: a credit note made outside the system is registered only in
   * place of one that was parked for a person (`replacesInvoiceId`, with `associatedVoucher`).
   */
  type: z.enum(INVOICE_TYPES),
  pointOfSale: PointOfSaleNumber,
  number: z.int().min(1).max(99_999_999),
  /** The 14 digits of the CAE. */
  cae: z.string().regex(/^[0-9]{14}$/),
  issueDate: z.iso.date(),
  caeExpiresOn: z.iso.date().optional(),
  /** Must be what the lines add up to. */
  totalCents: PositiveCents,
  /**
   * The pending invoice this voucher stands in for (the one that could not be issued during an
   * outage). It is closed as rejected, so it is never issued as well, and its lines are used here.
   */
  replacesInvoiceId: z.uuid().optional(),
  /**
   * For a credit note: the voucher it cancels (type, point of sale and number). It must be the voucher
   * the parked credit note cancels. Absent for an invoice.
   */
  associatedVoucher: z
    .strictObject({
      type: z.enum(INVOICE_ONLY_TYPES),
      pointOfSale: PointOfSaleNumber,
      number: z.int().min(1).max(99_999_999),
    })
    .optional(),
  /**
   * The owner or admin knows that the invoice `replacesInvoiceId` names was sent to the authority and
   * that nobody knows whether it was issued (a lost answer), and registers this voucher in its place
   * anyway. Without it that replacement is refused. If the invoice turns out to have been issued, the
   * organization holds two vouchers for one service: the replacement is audited and a person is told to
   * look for the voucher in ARCA (JD-S4 R2-2).
   */
  acknowledgeUnknownOutcome: z.boolean().optional(),
  lines: InvoiceLinesInput,
  recipient: InvoiceRecipientInput,
});
export type CreateManualInvoiceRequest = z.infer<typeof CreateManualInvoiceRequest>;

export const InvoiceRecipientDto = z.strictObject({
  kind: z.enum(INVOICE_RECIPIENT_KINDS),
  patientId: z.uuid().nullable(),
  tenantPayerId: z.uuid().nullable(),
  name: z.string().nullable(),
  taxCondition: z.enum(RECIPIENT_TAX_CONDITIONS),
  document: z
    .strictObject({ type: z.enum(RECIPIENT_DOCUMENT_TYPES), number: z.string() })
    .nullable(),
});
export type InvoiceRecipientDto = z.infer<typeof InvoiceRecipientDto>;

export const InvoiceLineDto = z.strictObject({
  id: z.uuid(),
  chargeLineId: z.uuid(),
  chargeId: z.uuid(),
  description: z.string(),
  amountCents: z.int(),
});
export type InvoiceLineDto = z.infer<typeof InvoiceLineDto>;

/**
 * An invoice or a credit note, as the screens read it. The state is one of four. The retry
 * progress of a pending invoice is not here on purpose: a person sees "pending", its age and, past
 * the threshold, the outage flag.
 */
export const InvoiceDto = z.strictObject({
  id: z.uuid(),
  kind: z.enum(INVOICE_KINDS),
  type: z.enum(INVOICE_TYPES),
  status: z.enum(INVOICE_STATUSES),
  pointOfSale: z.int(),
  number: z.int().nullable(),
  cae: z.string().nullable(),
  caeExpiresOn: z.iso.date().nullable(),
  issueDate: z.iso.date(),
  environment: z.enum(FISCAL_ENVIRONMENTS),
  /** A simulator is behind the voucher. */
  simulated: z.boolean(),
  /** The document says "documento de prueba sin validez fiscal": a test environment or a simulator. */
  testDocument: z.boolean(),
  recipient: InvoiceRecipientDto,
  totalCents: z.int(),
  netCents: z.int(),
  vatCents: z.int(),
  exemptCents: z.int(),
  /** The invoice a credit note cancels. */
  creditNoteOfId: z.uuid().nullable(),
  reason: z.string().nullable(),
  /** The rejected attempt this one retries. */
  previousAttemptId: z.uuid().nullable(),
  /** What the tax authority said about a rejected attempt. */
  rejectionMessage: z.string().nullable(),
  /** For an invoice: what its credit notes (issued or still pending) take back so far. */
  creditedCents: z.int(),
  /** Pending only: minutes since it was requested. */
  ageMinutes: z.int().nullable(),
  /** Pending only: it waited longer than the threshold of the organization (a prolonged outage). */
  outageFlag: z.boolean(),
  /**
   * Pending only: the invoice of the same series (point of sale and type) that holds this one back,
   * because the request to the authority may have been answered and nothing of the series is sent
   * until that is settled. Null when nothing holds it.
   */
  heldBy: z.strictObject({ id: z.uuid(), requestedAt: z.iso.datetime() }).nullable(),
  /** How many invoices of the series wait for this one to be settled (zero for most). */
  blocksSeries: z.int().min(0),
  hasPdf: z.boolean(),
  createdAt: z.iso.datetime(),
  issuedAt: z.iso.datetime().nullable(),
  lines: z.array(InvoiceLineDto),
});
export type InvoiceDto = z.infer<typeof InvoiceDto>;

const QueryFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const InvoiceListQuery = z.strictObject({
  status: z.enum(INVOICE_STATUSES).optional(),
  kind: z.enum(INVOICE_KINDS).optional(),
  patientId: z.uuid().optional(),
  /** The invoices that cover a line of this charge. */
  chargeId: z.uuid().optional(),
  /** The credit notes of this invoice. */
  creditNoteOfId: z.uuid().optional(),
  /** `true`: the pending ones that waited longer than the threshold (a prolonged outage). */
  prolonged: QueryFlag.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type InvoiceListQuery = z.infer<typeof InvoiceListQuery>;

export const InvoiceListResponse = z.strictObject({
  invoices: z.array(InvoiceDto),
  /** The setting that decides the outage flag, so a screen can say it. */
  outageThresholdHours: z.int(),
});
export type InvoiceListResponse = z.infer<typeof InvoiceListResponse>;

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
 */
export const INVOICE_DELIVERY_STATES = ['queued', 'retrying', 'awaiting_reconciliation'] as const;
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

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

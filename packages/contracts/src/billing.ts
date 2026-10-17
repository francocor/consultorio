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

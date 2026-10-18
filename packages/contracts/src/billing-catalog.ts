/**
 * The error codes and audit actions of the billing module (pricing, charges, payments, the cash
 * register, exports). They live apart from the schemas so the catalogs (errors.ts,
 * audit-actions.ts), which the sign-in bundle imports, do not pull in the module's request schemas.
 */

/**
 * Error codes of the billing module, with their status and the key of the es-AR message. They join
 * the API catalog (errors.ts); the messages go in `locales/es-AR/errors.billing.json`, keyed by the
 * code. The billing track (Track A) adds its codes here and nowhere else.
 */
export const BILLING_ERRORS = {
  // A price for the same type, scope and day already exists (and is active).
  billing_price_duplicate: { status: 409, i18nKey: 'errors.billing_price_duplicate' },
  // The payer is already in the organization's list.
  billing_payer_exists: { status: 409, i18nKey: 'errors.billing_payer_exists' },
  // The patient has not been checked in: a charge starts at check-in.
  charge_check_in_required: { status: 409, i18nKey: 'errors.charge_check_in_required' },
  // The appointment ended without the service (no-show, cancelled) and no fee applies.
  charge_not_billable: { status: 409, i18nKey: 'errors.charge_not_billable' },
  // Nothing prices the service: a person with billing permission has to type the amount.
  charge_amount_required: { status: 422, i18nKey: 'errors.charge_amount_required' },
  // An amount was typed but the catalog does have a price for the service.
  charge_price_exists: { status: 409, i18nKey: 'errors.charge_price_exists' },
  // The charge is voided: it takes no lines, no payments and no further changes.
  charge_voided: { status: 409, i18nKey: 'errors.charge_voided' },
  // Void refused: payments exist, refund them first.
  charge_has_payments: { status: 409, i18nKey: 'errors.charge_has_payments' },
  // Void refused: an electronic invoice was issued, a credit note has to cover it first.
  charge_has_invoice: { status: 409, i18nKey: 'errors.charge_has_invoice' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/**
 * Audit actions of billing. They are registered in the shared catalogue. `export.requested` belongs
 * here because the export platform (`platform/exports`) is built by this track; the reports use it.
 */
export const BILLING_AUDIT_ACTIONS = [
  'billing.price.changed',
  'billing.price.override',
  'charge.captured',
  'charge.voided',
  'charge.flagged',
  'payment.recorded',
  'payment.override',
  'payment.refunded',
  'cash.opened',
  'cash.closed',
  'cash.adjusted',
  'export.requested',
] as const;

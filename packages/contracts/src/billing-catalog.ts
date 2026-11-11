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
  // The payment is above what the patient owes and nobody confirmed the credit balance.
  payment_overpayment: { status: 409, i18nKey: 'errors.payment_overpayment' },
  // The voucher or transfer number was already recorded; repeating it needs a reason.
  payment_voucher_duplicate: { status: 409, i18nKey: 'errors.payment_voucher_duplicate' },
  // The same submission key was used for a different payment.
  idempotency_key_reused: { status: 409, i18nKey: 'errors.idempotency_key_reused' },
  // Cash needs the open register of the location, and there is none.
  cash_register_required: { status: 409, i18nKey: 'errors.cash_register_required' },
  // A refund cannot take back more than what is left of the payment.
  payment_refund_exceeds: { status: 409, i18nKey: 'errors.payment_refund_exceeds' },
  // A register is already open at the location.
  cash_register_open: { status: 409, i18nKey: 'errors.cash_register_open' },
  // The register is closed: it takes no entries and cannot be closed again.
  cash_register_closed: { status: 409, i18nKey: 'errors.cash_register_closed' },
  // Counted and expected cash differ and no reason was given.
  cash_difference_reason_required: {
    status: 422,
    i18nKey: 'errors.cash_difference_reason_required',
  },
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

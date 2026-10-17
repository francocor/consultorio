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
export const BILLING_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

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

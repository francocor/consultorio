/**
 * The error codes and audit actions of the invoicing module (fiscal configuration, AFIP invoices,
 * credit notes), apart from its schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the invoicing module, with their status and the key of the es-AR message. They
 * join the API catalog (errors.ts); the messages go in `locales/es-AR/errors.invoicing.json`, keyed
 * by the code. The invoicing track (Track C) adds its codes here and nowhere else.
 */
export const INVOICING_ERRORS = {
  // The certificate is checked against the CUIT of the fiscal profile, which does not exist yet.
  fiscal_profile_required: { status: 409, i18nKey: 'errors.fiscal_profile_required' },
  // Invoicing is not available: switched off, no fiscal profile, no point of sale, a certificate
  // problem or no issuer. The readiness endpoint says which.
  invoicing_not_ready: { status: 409, i18nKey: 'errors.invoicing_not_ready' },
  // A voided charge is final: nothing is invoiced over it.
  invoice_charge_voided: { status: 409, i18nKey: 'errors.invoice_charge_voided' },
  // The lines are not of one recipient (two patients, two payers, or a patient and a payer portion).
  invoice_lines_mixed: { status: 422, i18nKey: 'errors.invoice_lines_mixed' },
  // The amount is above what is not yet invoiced of the line.
  invoice_line_over_invoiced: { status: 409, i18nKey: 'errors.invoice_line_over_invoiced' },
  // A Factura to a payer needs the payer's CUIT, which the organization enters in the payer settings.
  invoice_payer_cuit_required: { status: 409, i18nKey: 'errors.invoice_payer_cuit_required' },
  // The point of sale is not one of the active ones, or there are several and none was chosen.
  invoice_point_of_sale_invalid: { status: 422, i18nKey: 'errors.invoice_point_of_sale_invalid' },
  // An issued invoice is not voided or deleted: a credit note cancels it.
  invoice_cannot_void: { status: 409, i18nKey: 'errors.invoice_cannot_void' },
  // The notes of an invoice cannot add up to more than the invoice.
  invoice_credit_note_exceeds: { status: 409, i18nKey: 'errors.invoice_credit_note_exceeds' },
  // Only an issued or registered invoice has a credit note (and a credit note has none).
  invoice_credit_note_not_applicable: {
    status: 409,
    i18nKey: 'errors.invoice_credit_note_not_applicable',
  },
  // A voucher with this type, point of sale and number is already registered.
  invoice_number_taken: { status: 409, i18nKey: 'errors.invoice_number_taken' },
  // Only a rejected attempt that nobody retried yet can be retried.
  invoice_not_rejected: { status: 409, i18nKey: 'errors.invoice_not_rejected' },
  // The PDF of an invoice exists once it is issued and has been rendered.
  invoice_pdf_not_ready: { status: 409, i18nKey: 'errors.invoice_pdf_not_ready' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of invoicing. They are registered in the shared catalogue. */
export const INVOICING_AUDIT_ACTIONS = [
  'invoice.requested',
  'invoice.issued',
  'invoice.rejected',
  'invoice.retried',
  'invoice.manual',
  'invoice.credit_note',
  'invoicing.config.changed',
  'invoicing.credential.changed',
] as const;

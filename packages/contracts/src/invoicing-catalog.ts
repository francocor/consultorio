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
  // The request to the authority may have been answered and the answer is not known yet: a manual
  // voucher does not replace the invoice until it is reconciled.
  invoice_awaiting_reconciliation: {
    status: 409,
    i18nKey: 'errors.invoice_awaiting_reconciliation',
  },
  // The voucher that replaces a pending invoice must cover its lines and be for its recipient.
  invoice_replacement_mismatch: { status: 409, i18nKey: 'errors.invoice_replacement_mismatch' },
  // The issuer an invoice was requested with is not the one the certificate of the organization is
  // for (the CUIT changed): nothing is signed for one CUIT and sent for another (JD-S4 R2-B-T5).
  invoice_issuer_mismatch: { status: 409, i18nKey: 'errors.invoice_issuer_mismatch' },
  // A CAE belongs to one voucher of the organization.
  invoice_cae_taken: { status: 409, i18nKey: 'errors.invoice_cae_taken' },
  // The environment of a point of sale does not change once invoices went through it: the numbers
  // of the other environment start again and would collide with the vouchers that exist.
  point_of_sale_has_invoices: { status: 409, i18nKey: 'errors.point_of_sale_has_invoices' },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/** Audit actions of invoicing. They are registered in the shared catalogue. */
export const INVOICING_AUDIT_ACTIONS = [
  'invoice.requested',
  'invoice.issued',
  'invoice.rejected',
  'invoice.retried',
  'invoice.manual',
  'invoice.credit_note',
  'invoice.attempted',
  'invoice.needs_attention',
  'invoice.voucher_orphaned',
  'invoice.voucher_adopted',
  'invoice.replaced_unresolved',
  'invoicing.config.changed',
  'invoicing.credential.changed',
] as const;

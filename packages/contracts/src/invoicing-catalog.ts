/**
 * The error codes and audit actions of the invoicing module (fiscal configuration, AFIP invoices,
 * credit notes), apart from its schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the invoicing module, with their status and the key of the es-AR message. They
 * join the API catalog (errors.ts); the messages go in `locales/es-AR/errors.invoicing.json`, keyed
 * by the code. The invoicing track (Track C) adds its codes here and nowhere else.
 */
export const INVOICING_ERRORS = {} as const satisfies Record<
  string,
  { status: number; i18nKey: string }
>;

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

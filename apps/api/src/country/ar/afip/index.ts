import type { InvoiceRules } from '../../../platform/country/country-pack.js';

import { checkRecipient, creditNoteTypeFor, resolveInvoiceType } from './invoice-type.js';

/** The AFIP rules of Argentina, as the pack hands them out. */
export const AR_INVOICE_RULES: InvoiceRules = {
  resolveInvoiceType,
  creditNoteTypeFor,
  checkRecipient,
};

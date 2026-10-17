import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * What billing asks invoicing before it voids a charge (billing-payments, "Void a charge"): is there
 * an invoice over any line of it? A charge with an issued (or manual) invoice cannot be voided; the
 * user is sent to the credit note flow instead.
 */
export interface InvoiceLookup {
  /** True when an issued or manual invoice, not fully reversed by credit notes, covers the charge. */
  hasIssuedInvoice(tx: Tx, chargeId: string): Promise<boolean>;
}

/**
 * The answer until invoices exist: none. It lets the billing track build and test the void rule
 * without waiting for the invoicing track, which replaces this object with the real lookup in
 * S4.10 (task 4.45) and changes nothing for the caller.
 */
export const invoiceLookup: InvoiceLookup = {
  hasIssuedInvoice: () => Promise.resolve(false),
};

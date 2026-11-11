import { sql } from 'drizzle-orm';

import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * What billing asks invoicing before it voids a charge (billing-payments, "Void a charge"): is there
 * an invoice over any line of it? A charge with an invoice standing over it cannot be voided; the
 * user is sent to the credit note flow instead.
 */
export interface InvoiceLookup {
  /**
   * True when an invoice stands over the charge: an issued or registered one, or one still pending
   * (it will be issued), not fully taken back by credit notes that were issued.
   */
  hasIssuedInvoice(tx: Tx, chargeId: string): Promise<boolean>;
}

/**
 * The real lookup (S4.10, task 4.45); billing calls it from the void rule with the signature the
 * seam left. A line counts as invoiced when its invoices (pending, issued, registered) add up to more
 * than the credit notes that were ISSUED against them; a rejected attempt covers nothing. The same
 * rule the database applies to `charge_line.invoiced_cents`, read from the invoice tables because
 * invoicing never reads billing's.
 */
export const invoiceLookup: InvoiceLookup = {
  async hasIssuedInvoice(tx, chargeId) {
    const result = await tx.execute<{ standing: boolean }>(
      sql`SELECT EXISTS (
            SELECT 1
              FROM invoice_line il
              JOIN invoice i ON i.tenant_id = il.tenant_id AND i.id = il.invoice_id
             WHERE il.charge_id = ${chargeId}
               AND CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN i.status IN ('issued', 'manual')
                        ELSE i.status IN ('pending', 'issued', 'manual') END
             GROUP BY il.charge_line_id
            HAVING sum(CASE WHEN i.type IN ('NCA', 'NCB', 'NCC') THEN -il.amount_cents
                            ELSE il.amount_cents END) > 0
          ) AS standing`,
    );
    return result.rows[0]?.standing === true;
  },
};

import { asc } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { cashSession, payment, paymentReversal } from '../../../db/schema/billing-payments.js';
import { payerPlanPrice, price, tenantPayer } from '../../../db/schema/billing-pricing.js';
import type { ExportContributor } from '../../tenancy/index.js';

/** The hash that tells a retry from another request is internal: it does not leave with the export. */
function withoutHash<T extends { requestHash: string }>(entry: T): Omit<T, 'requestHash'> {
  const copy: Partial<T> = { ...entry };
  delete copy.requestHash;
  return copy as Omit<T, 'requestHash'>;
}

/**
 * Administrative export part owned by billing, for an organization that leaves: its payers, the
 * price list, every charge with its lines, every payment and refund, and the cash registers. All of
 * it is money and the people it concerns by id; nothing clinical is stored in billing, and no
 * column of these tables can hold a card number. The exports a person asks for (charges, payments,
 * payer settlement) are a different thing: see `export-sources.ts`.
 */
export const exportBilling: ExportContributor = async ({ tx }) => {
  const [payers, prices, payerPrices, charges, lines, payments, reversals, sessions] =
    await Promise.all([
      tx.select().from(tenantPayer).orderBy(asc(tenantPayer.createdAt), asc(tenantPayer.id)),
      tx.select().from(price).orderBy(asc(price.createdAt), asc(price.id)),
      tx
        .select()
        .from(payerPlanPrice)
        .orderBy(asc(payerPlanPrice.createdAt), asc(payerPlanPrice.id)),
      tx.select().from(charge).orderBy(asc(charge.createdAt), asc(charge.id)),
      tx.select().from(chargeLine).orderBy(asc(chargeLine.chargeId), asc(chargeLine.position)),
      tx.select().from(payment).orderBy(asc(payment.paidAt), asc(payment.id)),
      tx
        .select()
        .from(paymentReversal)
        .orderBy(asc(paymentReversal.reversedAt), asc(paymentReversal.id)),
      tx.select().from(cashSession).orderBy(asc(cashSession.openedAt), asc(cashSession.id)),
    ]);

  return {
    payers,
    prices,
    payerPrices,
    charges,
    chargeLines: lines,
    payments: payments.map(withoutHash),
    paymentReversals: reversals.map(withoutHash),
    cashSessions: sessions,
  };
};

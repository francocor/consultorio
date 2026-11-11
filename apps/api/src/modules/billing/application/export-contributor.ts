import { asc, sql } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import { cashSession, payment, paymentReversal } from '../../../db/schema/billing-payments.js';
import { payerPlanPrice, price, tenantPayer } from '../../../db/schema/billing-pricing.js';
import {
  afterStamp,
  pagedByStamp,
  pagedRows,
  stampText,
  type ExportContributor,
} from '../../tenancy/index.js';

/** The hash that tells a retry from another request is internal: it does not leave with the export. */
function withoutHash<T extends { requestHash: string }>(entry: T): Omit<T, 'requestHash'> {
  const copy: Partial<T> = { ...entry };
  delete copy.requestHash;
  return copy as Omit<T, 'requestHash'>;
}

/** Where a line of a charge is in the order of the export: its charge and its position in it. */
interface LineCursor {
  chargeId: string;
  position: number;
}

/**
 * Administrative export part owned by billing, for an organization that leaves: its payers, the
 * price list, every charge with its lines, every payment and refund, and the cash registers. All of
 * it is money and the people it concerns by id; nothing clinical is stored in billing, and no
 * column of these tables can hold a card number. The exports a person asks for (charges, payments,
 * payer settlement) are a different thing: see `export-sources.ts`.
 *
 * The charges, their lines, the payments and the refunds grow with every visit, so they are read a
 * page at a time. The payers, the price lists and the cash sessions are as many as the organization
 * sets up or opens in a day, and stay lists.
 */
export const exportBilling: ExportContributor = async ({ tx, pageSize }) => {
  const [payers, prices, payerPrices, sessions] = await Promise.all([
    tx.select().from(tenantPayer).orderBy(asc(tenantPayer.createdAt), asc(tenantPayer.id)),
    tx.select().from(price).orderBy(asc(price.createdAt), asc(price.id)),
    tx.select().from(payerPlanPrice).orderBy(asc(payerPlanPrice.createdAt), asc(payerPlanPrice.id)),
    tx.select().from(cashSession).orderBy(asc(cashSession.openedAt), asc(cashSession.id)),
  ]);

  return {
    payers,
    prices,
    payerPrices,
    charges: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            row: charge,
            cursorAt: stampText(charge.createdAt),
            cursorId: charge.id,
          })
          .from(charge)
          .where(afterStamp(charge.createdAt, charge.id, after))
          .orderBy(asc(charge.createdAt), asc(charge.id))
          .limit(limit),
      project: ({ row }) => row,
    }),
    chargeLines: pagedRows<typeof chargeLine.$inferSelect, LineCursor>({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select()
          .from(chargeLine)
          .where(
            after === null
              ? undefined
              : sql`(${chargeLine.chargeId}, ${chargeLine.position}) > (${after.chargeId}::uuid, ${after.position}::int)`,
          )
          .orderBy(asc(chargeLine.chargeId), asc(chargeLine.position))
          .limit(limit),
      cursorOf: (row) => ({ chargeId: row.chargeId, position: row.position }),
    }),
    payments: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            row: payment,
            cursorAt: stampText(payment.paidAt),
            cursorId: payment.id,
          })
          .from(payment)
          .where(afterStamp(payment.paidAt, payment.id, after))
          .orderBy(asc(payment.paidAt), asc(payment.id))
          .limit(limit),
      project: ({ row }) => withoutHash(row),
    }),
    paymentReversals: pagedByStamp({
      pageSize,
      fetch: (after, limit) =>
        tx
          .select({
            row: paymentReversal,
            cursorAt: stampText(paymentReversal.reversedAt),
            cursorId: paymentReversal.id,
          })
          .from(paymentReversal)
          .where(afterStamp(paymentReversal.reversedAt, paymentReversal.id, after))
          .orderBy(asc(paymentReversal.reversedAt), asc(paymentReversal.id))
          .limit(limit),
      project: ({ row }) => withoutHash(row),
    }),
    cashSessions: sessions,
  };
};

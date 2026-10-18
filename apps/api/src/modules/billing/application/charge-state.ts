import { and, eq, ne } from 'drizzle-orm';

import { charge, chargeLine } from '../../../db/schema/billing-charges.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { chargeStatusOf, summarizeCharge } from '../domain/charge-status.js';

import { paidNetByCharge } from './payment-totals.js';

/**
 * Derives the state of a charge from its lines and what was paid and refunded, and stores it when
 * it moved. Called in the transaction of whatever changed an input (a line, a payment, a refund),
 * after taking the lock on the charge, so two writers never leave a stale state. A voided charge
 * is final and is not touched.
 */
export async function refreshChargeStatus(tx: Tx, chargeId: string): Promise<void> {
  const [current] = await tx
    .select({ status: charge.status })
    .from(charge)
    .where(and(eq(charge.id, chargeId), ne(charge.status, 'voided')));
  if (!current) return;

  const lines = await tx.select().from(chargeLine).where(eq(chargeLine.chargeId, chargeId));
  const paid = (await paidNetByCharge(tx, [chargeId])).get(chargeId) ?? 0;
  const { patientCents } = summarizeCharge(lines, paid);
  const status = chargeStatusOf({ voided: false, patientCents, paidNetCents: paid });
  if (status !== current.status) {
    await tx.update(charge).set({ status }).where(eq(charge.id, chargeId));
  }
}

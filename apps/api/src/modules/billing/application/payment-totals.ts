import {
  PAYMENT_METHODS,
  PAYMENT_REVERSAL_KINDS,
  money,
  type PaymentDto,
} from '@consultorio/contracts';
import { asc, inArray, sql } from 'drizzle-orm';

import { payment, paymentReversal } from '../../../db/schema/billing-payments.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

function oneOf<T extends string>(values: readonly T[], value: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`unexpected value "${value}" in a payment`);
  return found;
}

/**
 * What the patient has paid of each charge, net of refunds and corrections, in cents. The sum is
 * made by the database over append-only rows, so it is always what the entries say.
 */
export async function paidNetByCharge(
  tx: Tx,
  chargeIds: readonly string[],
): Promise<Map<string, number>> {
  const net = new Map(chargeIds.map((id) => [id, 0]));
  if (chargeIds.length === 0) return net;
  const ids = [...chargeIds];

  const [paid, reversed] = await Promise.all([
    tx
      .select({ chargeId: payment.chargeId, total: sql<string>`sum(${payment.amountCents})` })
      .from(payment)
      .where(inArray(payment.chargeId, ids))
      .groupBy(payment.chargeId),
    tx
      .select({
        chargeId: paymentReversal.chargeId,
        total: sql<string>`sum(${paymentReversal.amountCents})`,
      })
      .from(paymentReversal)
      .where(inArray(paymentReversal.chargeId, ids))
      .groupBy(paymentReversal.chargeId),
  ]);
  for (const row of paid) net.set(row.chargeId, (net.get(row.chargeId) ?? 0) + Number(row.total));
  for (const row of reversed) {
    net.set(row.chargeId, (net.get(row.chargeId) ?? 0) - Number(row.total));
  }
  return net;
}

/** The payments of some charges with their reversals, oldest first, as the screens read them. */
export async function paymentsByCharge(
  tx: Tx,
  chargeIds: readonly string[],
): Promise<Map<string, PaymentDto[]>> {
  const result = new Map<string, PaymentDto[]>(chargeIds.map((id) => [id, []]));
  if (chargeIds.length === 0) return result;
  const ids = [...chargeIds];

  const [payments, reversals] = await Promise.all([
    tx
      .select()
      .from(payment)
      .where(inArray(payment.chargeId, ids))
      .orderBy(asc(payment.paidAt), asc(payment.id)),
    tx
      .select()
      .from(paymentReversal)
      .where(inArray(paymentReversal.chargeId, ids))
      .orderBy(asc(paymentReversal.reversedAt), asc(paymentReversal.id)),
  ]);

  for (const row of payments) {
    const taken = reversals.filter((reversal) => reversal.paymentId === row.id);
    const reversedCents = taken.reduce((sum, reversal) => sum + reversal.amountCents, 0);
    result.get(row.chargeId)?.push({
      id: row.id,
      chargeId: row.chargeId,
      method: oneOf(PAYMENT_METHODS, row.method),
      amountCents: money(row.amountCents),
      creditCents: money(row.creditCents),
      paidAt: row.paidAt.toISOString(),
      recordedBy: row.recordedBy,
      externalRef: row.externalRef,
      overrideReason: row.overrideReason,
      cashSessionId: row.cashSessionId,
      correctsPaymentId: row.correctsPaymentId,
      reversedCents: money(reversedCents),
      netCents: money(row.amountCents - reversedCents),
      reversals: taken.map((reversal) => ({
        id: reversal.id,
        kind: oneOf(PAYMENT_REVERSAL_KINDS, reversal.kind),
        amountCents: money(reversal.amountCents),
        reason: reversal.reason,
        reversedBy: reversal.reversedBy,
        reversedAt: reversal.reversedAt.toISOString(),
        cashSessionId: reversal.cashSessionId,
      })),
    });
  }
  return result;
}

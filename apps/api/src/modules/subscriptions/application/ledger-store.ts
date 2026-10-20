import { and, eq, sql } from 'drizzle-orm';

import {
  subscription,
  subscriptionPayment,
  subscriptionRefund,
  type SubscriptionPaymentRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import {
  planLedger,
  type LedgerPlan,
  type PaymentPurpose,
  type RecordedPayment,
} from '../domain/ledger.js';

import { SYSTEM_ACTOR } from './common.js';
import type { PaymentDescription } from './ports.js';

/** The payments already recorded for a subscription, in the shape the ledger plans against. */
export async function loadRecorded(
  tx: Tx,
  subscriptionId: string,
): Promise<{
  recorded: Map<string, RecordedPayment>;
  rows: SubscriptionPaymentRow[];
  lastPaidPeriod: string | null;
}> {
  const rows = await tx
    .select()
    .from(subscriptionPayment)
    .where(eq(subscriptionPayment.subscriptionId, subscriptionId));
  let lastPaidPeriod: string | null = null;
  const recorded = new Map<string, RecordedPayment>();
  for (const row of rows) {
    recorded.set(row.providerPaymentId, {
      providerPaymentId: row.providerPaymentId,
      status: row.status as RecordedPayment['status'],
      refundedCents: row.refundedCents,
      purpose: row.purpose as PaymentPurpose,
      period: row.period,
      surplus: row.surplus,
      credited: row.credited,
    });
    if (row.credited && !row.surplus && row.period !== null) {
      if (lastPaidPeriod === null || row.period > lastPaidPeriod) lastPaidPeriod = row.period;
    }
  }
  return { recorded, rows, lastPaidPeriod };
}

export interface LedgerApplied {
  plan: LedgerPlan;
  /** The subscription after `paid_through` moved (the same row when it did not). */
  row: SubscriptionRow;
}

/**
 * Writes what the provider says about the payments of a subscription, once. The plan is pure
 * (`domain/ledger.ts`); this stores it: a payment recorded by the id the provider gave it, a surplus
 * flagged for the operator and audited, the end of the paid time moved only by a payment that counts,
 * and every refund the provider reports as an entry of its own. Running it again over the same
 * payments writes nothing.
 */
export async function applyLedger(
  tx: Tx,
  row: SubscriptionRow,
  payments: readonly PaymentDescription[],
): Promise<LedgerApplied> {
  const { recorded, lastPaidPeriod } = await loadRecorded(tx, row.id);
  const plan = planLedger({ payments, recorded, lastPaidPeriod, paidThrough: row.paidThrough });

  for (const operation of plan.operations) {
    const payment = operation.payment;
    if (operation.type === 'insert') {
      await tx
        .insert(subscriptionPayment)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          subscriptionId: row.id,
          providerPaymentId: payment.paymentId,
          purpose: operation.purpose,
          reference: payment.externalReference,
          amountCents: payment.amountCents,
          status: payment.status,
          refundedCents: payment.refundedCents,
          period: operation.period,
          surplus: operation.surplus,
          credited: operation.credited,
          approvedAt: payment.approvedAt === undefined ? null : new Date(payment.approvedAt),
          providerCreatedAt: new Date(payment.createdAt),
        })
        .onConflictDoNothing({
          target: [subscriptionPayment.tenantId, subscriptionPayment.providerPaymentId],
        });
    } else {
      await tx
        .update(subscriptionPayment)
        .set({
          status: payment.status,
          refundedCents: payment.refundedCents,
          approvedAt: payment.approvedAt === undefined ? null : new Date(payment.approvedAt),
          ...(operation.credit
            ? {
                credited: true,
                period: operation.credit.period,
                surplus: operation.credit.surplus,
              }
            : {}),
        })
        .where(
          and(
            eq(subscriptionPayment.subscriptionId, row.id),
            eq(subscriptionPayment.providerPaymentId, payment.paymentId),
          ),
        );
    }
  }

  for (const paymentId of plan.effects.surplusPaymentIds) {
    await audit(tx, {
      action: 'subscription.surplus_flagged',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'subscription',
      resourceId: row.id,
      metadata: { providerPaymentId: paymentId },
    });
  }

  await recordProviderRefunds(tx, row.id, payments);

  let current = row;
  if (plan.effects.paidThrough !== null) {
    const [moved] = await tx
      .update(subscription)
      .set({ paidThrough: plan.effects.paidThrough, version: row.version + 1 })
      .where(eq(subscription.id, row.id))
      .returning();
    if (moved) current = moved;
  }
  return { plan, row: current };
}

/** Every refund the provider reports becomes an entry; the ones recorded already are left as they are. */
async function recordProviderRefunds(
  tx: Tx,
  subscriptionId: string,
  payments: readonly PaymentDescription[],
): Promise<void> {
  for (const payment of payments) {
    if (payment.refunds.length === 0) continue;
    const [row] = await tx
      .select({ id: subscriptionPayment.id })
      .from(subscriptionPayment)
      .where(
        and(
          eq(subscriptionPayment.subscriptionId, subscriptionId),
          eq(subscriptionPayment.providerPaymentId, payment.paymentId),
        ),
      );
    if (!row) continue;
    for (const refund of payment.refunds) {
      await tx
        .insert(subscriptionRefund)
        .values({
          tenantId: sql`current_setting('app.tenant_id')::uuid`,
          paymentId: row.id,
          providerRefundId: refund.refundId,
          amountCents: refund.amountCents,
          source: 'provider',
          providerCreatedAt: new Date(refund.createdAt),
        })
        .onConflictDoNothing({
          target: [subscriptionRefund.tenantId, subscriptionRefund.providerRefundId],
        });
    }
  }
}

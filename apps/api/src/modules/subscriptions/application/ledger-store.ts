import { and, eq, sql } from 'drizzle-orm';

import {
  subscription,
  subscriptionAttempt,
  subscriptionPayment,
  subscriptionRefund,
  type SubscriptionPaymentRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import {
  planLedger,
  type LedgerOwnership,
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
  alsoEarlier: ReadonlySet<string> = new Set(),
): Promise<LedgerApplied> {
  const { recorded, lastPaidPeriod } = await loadRecorded(tx, row.id);
  const ownership = await loadOwnership(tx, row, alsoEarlier);
  const plan = planLedger({
    payments,
    recorded,
    lastPaidPeriod,
    paidThrough: row.paidThrough,
    ownership,
  });

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

  for (const { paymentId, reason } of plan.effects.flagged) {
    await audit(tx, {
      action: 'subscription.surplus_flagged',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'subscription',
      resourceId: row.id,
      metadata: { providerPaymentId: paymentId, reason },
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

/**
 * What the platform owns of what the provider can answer: the preapproval the subscription charges
 * through, the ones it held before (and the ones found alive after it gave them up), and the links it
 * made. A payment is credited only when it belongs to one of them (JD-S6 R1, A-W10).
 */
async function loadOwnership(
  tx: Tx,
  row: SubscriptionRow,
  alsoEarlier: ReadonlySet<string>,
): Promise<LedgerOwnership> {
  const confirmed = await tx
    .select({
      kind: subscriptionAttempt.kind,
      reference: subscriptionAttempt.externalReference,
      amountCents: subscriptionAttempt.amountCents,
      resourceId: subscriptionAttempt.resourceId,
    })
    .from(subscriptionAttempt)
    .where(
      and(
        eq(subscriptionAttempt.subscriptionId, row.id),
        eq(subscriptionAttempt.state, 'confirmed'),
      ),
    );
  const earlier = new Set<string>(alsoEarlier);
  for (const attempt of confirmed) {
    if (attempt.kind === 'preapproval' && attempt.resourceId !== null)
      earlier.add(attempt.resourceId);
  }
  if (row.providerPreapprovalId !== null) earlier.delete(row.providerPreapprovalId);
  return {
    preapprovalId: row.providerPreapprovalId,
    earlierPreapprovalIds: earlier,
    links: confirmed
      .filter((attempt) => attempt.kind === 'payment_link')
      .map((attempt) => ({
        externalReference: attempt.reference,
        amountCents: attempt.amountCents,
        linkId: attempt.resourceId,
      })),
  };
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

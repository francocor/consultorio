import { asc, eq } from 'drizzle-orm';

import {
  plan,
  statement,
  subscription,
  subscriptionPayment,
} from '../../../db/schema/subscriptions.js';
import type { ExportContributor } from '../../tenancy/index.js';

/**
 * The subscriptions part of the cancellation export (administrative): the plan, the state and the
 * dates of the subscription, its published statements (professionals counted, prices, prorations and
 * overage lines with the ids of the events they bill) and the payments the provider confirmed. It holds
 * no clinical data, no message text, and never a payment method: the platform keeps only the label the
 * provider gives, and the identifiers of the provider (the preapproval, the payer and the id of each
 * payment) stay out: a payment is shown by its purpose, amount, status, period and approval date.
 */
export const exportSubscriptions: ExportContributor = async ({ tx }) => {
  const [current] = await tx
    .select({
      plan: plan.key,
      status: subscription.status,
      trialEndsAt: subscription.trialEndsAt,
      graceEndsAt: subscription.graceEndsAt,
      paidThrough: subscription.paidThrough,
      overageCapMessages: subscription.overageCapMessages,
      paymentMethodLabel: subscription.paymentMethodLabel,
      authorizedAmountCents: subscription.authorizedAmountCents,
      createdAt: subscription.createdAt,
    })
    .from(subscription)
    .innerJoin(plan, eq(plan.id, subscription.planId));
  const statements = await tx
    .select({
      period: statement.period,
      professionalsCounted: statement.professionalsCounted,
      baseCents: statement.baseCents,
      overageUnits: statement.overageUnits,
      overageCents: statement.overageCents,
      totalCents: statement.totalCents,
      overageCapMessages: statement.overageCapMessages,
      lines: statement.lines,
      publishedAt: statement.publishedAt,
      collectAfter: statement.collectAfter,
      collectedCents: statement.collectedCents,
      collectedAt: statement.collectedAt,
    })
    .from(statement)
    .orderBy(asc(statement.period));
  const payments = await tx
    .select({
      purpose: subscriptionPayment.purpose,
      amountCents: subscriptionPayment.amountCents,
      status: subscriptionPayment.status,
      refundedCents: subscriptionPayment.refundedCents,
      period: subscriptionPayment.period,
      approvedAt: subscriptionPayment.approvedAt,
    })
    .from(subscriptionPayment)
    .orderBy(asc(subscriptionPayment.providerCreatedAt), asc(subscriptionPayment.id));

  return { subscription: current ?? null, statements, payments };
};

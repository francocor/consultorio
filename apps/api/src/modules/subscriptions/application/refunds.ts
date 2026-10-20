import { and, eq, sql } from 'drizzle-orm';

import {
  subscriptionPayment,
  subscriptionRefund,
  type SubscriptionPaymentRow,
} from '../../../db/schema/subscriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';

import {
  lockAttempt,
  markAttempt,
  noteUnknownOutcome,
  openAttempts,
  resolveAttempt,
} from './attempts.js';
import type { PaymentDescription, RefundResult } from './ports.js';
import { UNKNOWN_OUTCOME, callWithin, gatewayOf, type SubscriptionDeps } from './provider.js';
import { lockSubscription } from './store.js';

export type RefundOutcome =
  | { status: 'refunded'; refundId: string; amountCents: number }
  | { status: 'unavailable' }
  /** A refund of this payment is in flight, or its outcome is not known yet: nothing is sent again. */
  | { status: 'in_progress' }
  /** The subscription is parked for a person. */
  | { status: 'attention' }
  | { status: 'rejected'; message: string }
  | { status: 'not_refundable' };

export interface RefundInput {
  tenantId: string;
  /** The payment as the platform recorded it (`subscription_payment.id`). */
  paymentId: string;
  amountCents: number;
  /** Who asked: the platform operator. */
  actor: AuditActor;
  /** The operator, for the trail (a short label, never a name of a patient). */
  requestedBy: string;
}

interface Planned {
  payment: SubscriptionPaymentRow;
  attemptId: string;
  idempotencyKey: string;
}

/**
 * An operator refund (subscriptions, "Duplicate payment protection and refunds"). The refund is a
 * separate entry (`subscription_refund`): the payment keeps what it was. A refund is NOT safe to repeat
 * blindly, so it is written for a provider that may not honour the key:
 *
 * 1. the provider is asked for the payment BEFORE anything is sent (its refunds are what the caller
 *    compares with later) and the intent is committed in a short transaction;
 * 2. the call is bounded, abortable and made with nothing held;
 * 3. after an unknown outcome nothing is sent again until the settle window has passed and the
 *    payment shows no new refund; exactly one new refund of the amount asked is adopted, anything else
 *    is parked (`domain/attempt-decisions.ts`).
 */
export async function refundPayment(
  deps: SubscriptionDeps,
  input: RefundInput,
): Promise<RefundOutcome> {
  const gateway = gatewayOf(deps);
  if (!gateway) return { status: 'unavailable' };
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId: input.tenantId, userId: SYSTEM_USER_ID }, work);

  // Read what the platform recorded about the payment (no lock).
  const recorded = await as(async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptionPayment)
      .where(eq(subscriptionPayment.id, input.paymentId));
    return row ?? null;
  });
  if (!recorded) return { status: 'not_refundable' };
  if (
    (recorded.status !== 'approved' && recorded.status !== 'partially_refunded') ||
    !Number.isSafeInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > recorded.amountCents - recorded.refundedCents
  ) {
    return { status: 'not_refundable' };
  }

  // Ask the provider what the payment holds NOW: these are the refunds it had before the call.
  const before = await callWithin(
    deps,
    (signal) => gateway.getPayment(recorded.providerPaymentId, signal),
    undefined,
  );
  const lookup = before.value;
  if (lookup?.status !== 'found') return { status: 'unavailable' };
  const known: PaymentDescription = lookup.payment;
  if (input.amountCents > known.amountCents - known.refundedCents) {
    return { status: 'not_refundable' };
  }

  // The write-ahead mark, committed before the call.
  const planned = await as(async (tx): Promise<Planned | RefundOutcome> => {
    const sub = await lockSubscription(tx);
    if (!sub) return { status: 'not_refundable' };
    if (sub.attentionReason !== null) return { status: 'attention' };
    const now = deps.clock();
    const open = (await openAttempts(tx, sub.id)).filter(
      (attempt) => attempt.kind === 'refund' && attempt.paymentId === known.paymentId,
    );
    if (open.some((attempt) => attempt.state === 'parked')) return { status: 'attention' };
    // A refund that may be running at the provider: not sent again, not even after the window until
    // the payment was read and compared (that is the reconcile's job).
    if (open.length > 0) return { status: 'in_progress' };
    const attempt = await markAttempt(tx, {
      subscriptionId: sub.id,
      kind: 'refund',
      externalReference: `refund:${sub.id}:${known.paymentId}:${String(known.refunds.length + 1)}`,
      amountCents: input.amountCents,
      paymentId: known.paymentId,
      refundIdsBefore: known.refunds.map((refund) => refund.refundId),
      now,
      settleWindowMs: gateway.settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
    });
    return { payment: recorded, attemptId: attempt.id, idempotencyKey: attempt.idempotencyKey };
  });
  if ('status' in planned) return planned;

  const sent = await callWithin(
    deps,
    (signal) =>
      gateway.refund(
        { paymentId: known.paymentId, amountCents: input.amountCents },
        planned.idempotencyKey,
        signal,
      ),
    UNKNOWN_OUTCOME as RefundResult,
  );
  const timedOut = sent.timedOut || sent.threw;

  return as((tx) => settleRefund(tx, deps, input, planned, sent.value, timedOut));
}

async function settleRefund(
  tx: Tx,
  deps: SubscriptionDeps,
  input: RefundInput,
  planned: Planned,
  answer: RefundResult,
  timedOut: boolean,
): Promise<RefundOutcome> {
  const now = deps.clock();
  const sub = await lockSubscription(tx);
  const attempt = await lockAttempt(tx, planned.attemptId);
  if (!sub || !attempt) throw new Error('the subscription disappeared during the refund');
  // The reconcile settled it while the provider was being waited for.
  if (attempt.state !== 'marked') {
    return attempt.state === 'confirmed' && attempt.resourceId !== null
      ? { status: 'refunded', refundId: attempt.resourceId, amountCents: input.amountCents }
      : { status: attempt.state === 'parked' ? 'attention' : 'unavailable' };
  }

  if (answer.status === 'refunded') {
    await resolveAttempt(tx, attempt, {
      state: 'confirmed',
      resourceId: answer.refund.refundId,
      now,
    });
    await recordRefund(tx, input.actor, sub.id, planned.payment, answer.payment, answer.refund);
    return {
      status: 'refunded',
      refundId: answer.refund.refundId,
      amountCents: answer.refund.amountCents,
    };
  }
  if (answer.status === 'rejected') {
    await resolveAttempt(tx, attempt, { state: 'rejected', now, message: answer.message });
    return { status: 'rejected', message: answer.message };
  }
  if (!answer.outcomeUnknown && !timedOut) {
    await resolveAttempt(tx, attempt, { state: 'released', now, message: answer.message });
  } else {
    await noteUnknownOutcome(tx, attempt.id, answer.message);
  }
  return { status: 'unavailable' };
}

/** Writes the refund as an entry of its own, brings the payment to what the provider says, and audits it. */
export async function recordRefund(
  tx: Tx,
  actor: AuditActor,
  subscriptionId: string,
  payment: Pick<SubscriptionPaymentRow, 'id' | 'providerPaymentId'>,
  after: Pick<PaymentDescription, 'status' | 'refundedCents'>,
  refund: { refundId: string; amountCents: number; createdAt: string },
): Promise<void> {
  await tx
    .insert(subscriptionRefund)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      paymentId: payment.id,
      providerRefundId: refund.refundId,
      amountCents: refund.amountCents,
      source: 'operator',
      providerCreatedAt: new Date(refund.createdAt),
    })
    // The ledger may have recorded the very same refund as the provider's before this ran.
    .onConflictDoNothing({
      target: [subscriptionRefund.tenantId, subscriptionRefund.providerRefundId],
    });
  await tx
    .update(subscriptionPayment)
    .set({ status: after.status, refundedCents: after.refundedCents })
    .where(
      and(
        eq(subscriptionPayment.id, payment.id),
        sql`${subscriptionPayment.refundedCents} <= ${after.refundedCents}`,
      ),
    );
  await audit(tx, {
    action: 'subscription.refunded',
    outcome: 'allow',
    actor,
    resourceType: 'subscription',
    resourceId: subscriptionId,
    metadata: {
      providerPaymentId: payment.providerPaymentId,
      providerRefundId: refund.refundId,
      amountCents: refund.amountCents,
    },
  });
}

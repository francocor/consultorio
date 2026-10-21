import { and, asc, eq, sql } from 'drizzle-orm';

import {
  subscriptionAttempt,
  subscriptionPayment,
  subscriptionRefund,
  type SubscriptionPaymentRow,
} from '../../../db/schema/subscriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';

import {
  blocksProvider,
  lockAttempt,
  markAttempt,
  noteUnknownOutcome,
  openAttempts,
  resolveAttempt,
} from './attempts.js';
import { SYSTEM_ACTOR } from './common.js';
import type { PaymentDescription, RefundResult } from './ports.js';
import {
  UNKNOWN_OUTCOME,
  callWithin,
  gatewayOf,
  settleWindowOf,
  type SubscriptionDeps,
} from './provider.js';
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
  /**
   * The token the client made for THIS request (a double click, a retry after a timeout and a second
   * operator pressing the same button all carry the same one): a refund is made once per token, and a
   * second call with it gets the answer of the first instead of sending another (JD-S6 R1, S6-6).
   */
  clientToken?: string | undefined;
  /** Why, for the trail (`duplicate_of_overdue_link` when the platform gives a duplicate back itself). */
  reason?: string | undefined;
}

interface Planned {
  payment: SubscriptionPaymentRow;
  attemptId: string;
  idempotencyKey: string;
}

/** The reference of a refund: derived from the locked records, and from the token when there is one. */
const refundReference = (
  subscriptionId: string,
  providerPaymentId: string,
  suffix: string | number,
) => `refund:${subscriptionId}:${providerPaymentId}:${String(suffix)}`;

/**
 * The answer of a request that was made already with the same token: the refund it made, or the
 * refusal it got. `null` when there is none (or the one that was made was released, so the provider
 * provably did nothing and the request may be sent).
 */
async function answerOfEarlier(
  tx: Tx,
  subscriptionId: string,
  providerPaymentId: string,
  input: Pick<RefundInput, 'clientToken' | 'amountCents'>,
): Promise<RefundOutcome | null> {
  if (input.clientToken === undefined) return null;
  const [earlier] = await tx
    .select()
    .from(subscriptionAttempt)
    .where(
      and(
        eq(subscriptionAttempt.subscriptionId, subscriptionId),
        eq(subscriptionAttempt.kind, 'refund'),
        eq(
          subscriptionAttempt.externalReference,
          refundReference(subscriptionId, providerPaymentId, input.clientToken),
        ),
      ),
    )
    .orderBy(asc(subscriptionAttempt.markedAt))
    .limit(1);
  if (!earlier) return null;
  if (earlier.amountCents !== input.amountCents) return { status: 'not_refundable' };
  if (earlier.state === 'confirmed' && earlier.resourceId !== null) {
    return { status: 'refunded', refundId: earlier.resourceId, amountCents: earlier.amountCents };
  }
  if (earlier.state === 'rejected') {
    return { status: 'rejected', message: earlier.message ?? 'rejected' };
  }
  return null;
}

function refundable(
  payment: Pick<SubscriptionPaymentRow, 'status' | 'amountCents' | 'refundedCents'>,
  amountCents: number,
): boolean {
  return (
    (payment.status === 'approved' || payment.status === 'partially_refunded') &&
    Number.isSafeInteger(amountCents) &&
    amountCents > 0 &&
    amountCents <= payment.amountCents - payment.refundedCents
  );
}

/**
 * An operator refund (subscriptions, "Duplicate payment protection and refunds"). The refund is a
 * separate entry (`subscription_refund`): the payment keeps what it was. A refund is NOT safe to repeat
 * blindly, so it is written for a provider that may not honour the key:
 *
 * 1. the provider is asked for the payment BEFORE anything is sent (its refunds are what the caller
 *    compares with later) and the intent is committed in a short transaction, in which the payment and
 *    its refunds are read again UNDER THE LOCK of the subscription, so two refunds at once, or a
 *    second click, cannot both be planned from the same stale numbers;
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

  // Read what the platform recorded about the payment (no lock): enough to answer a request that was
  // made already, and to refuse early.
  const read = await as(async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptionPayment)
      .where(eq(subscriptionPayment.id, input.paymentId));
    if (!row) return null;
    const earlier = await answerOfEarlier(tx, row.subscriptionId, row.providerPaymentId, input);
    return { row, earlier };
  });
  if (!read) return { status: 'not_refundable' };
  if (read.earlier) return read.earlier;
  const recorded = read.row;
  if (!refundable(recorded, input.amountCents)) return { status: 'not_refundable' };

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
    if (blocksProvider(sub)) return { status: 'attention' };

    // A request that was made already (the same token): its answer, not another refund. Looked at under
    // the lock too, because a second click can arrive while the first one is being answered.
    const earlier = await answerOfEarlier(tx, sub.id, known.paymentId, input);
    if (earlier) return earlier;

    // Everything below is read again under the lock: the payment and its refunds are what they are NOW.
    const [payment] = await tx
      .select()
      .from(subscriptionPayment)
      .where(
        and(
          eq(subscriptionPayment.id, input.paymentId),
          eq(subscriptionPayment.subscriptionId, sub.id),
        ),
      )
      .for('update');
    if (!payment || !refundable(payment, input.amountCents)) return { status: 'not_refundable' };
    // The ledger has seen a refund the provider read above did not show: that read is stale.
    if (payment.refundedCents > known.refundedCents) return { status: 'unavailable' };
    const refunds = await tx
      .select({ id: subscriptionRefund.id })
      .from(subscriptionRefund)
      .where(eq(subscriptionRefund.paymentId, payment.id));
    const reference = refundReference(
      sub.id,
      known.paymentId,
      input.clientToken ?? refunds.length + 1,
    );

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
      externalReference: reference,
      amountCents: input.amountCents,
      paymentId: known.paymentId,
      refundIdsBefore: known.refunds.map((refund) => refund.refundId),
      clock: deps.clock,
      settleWindowMs: gateway.settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
    });
    return { payment, attemptId: attempt.id, idempotencyKey: attempt.idempotencyKey };
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
    await recordRefund(
      tx,
      input.actor,
      sub.id,
      planned.payment,
      answer.payment,
      answer.refund,
      now,
      input.reason,
    );
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
    await noteUnknownOutcome(tx, attempt.id, answer.message, {
      now,
      settleWindowMs: settleWindowOf(deps),
    });
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
  now: Date,
  reason?: string,
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
  // A surplus that was given back in full has been looked at: it stops counting as an unreviewed item.
  if (after.status === 'refunded') await markSurplusReviewed(tx, payment.id, now);
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
      ...(reason === undefined ? {} : { reason }),
    },
  });
}

/** The token an automatic refund carries in its reference; the reason of the refund is read back from it. */
export const AUTOMATIC_REFUND_PREFIX = 'auto-';

/** Why a refund was made, when the platform made it by itself (read from the reference it was made under). */
export function automaticReasonOf(reference: string): string | undefined {
  return reference.includes(`:${AUTOMATIC_REFUND_PREFIX}`)
    ? 'duplicate_of_overdue_link'
    : undefined;
}

/**
 * Marks a payment flagged as a surplus as looked at (`surplus_reviewed_at`): by the operator, who read
 * it and decided (refund it, or leave it), or by the platform after it gave the duplicate back.
 */
export async function markSurplusReviewed(tx: Tx, paymentId: string, now: Date): Promise<boolean> {
  const updated = await tx
    .update(subscriptionPayment)
    .set({ surplusReviewedAt: now })
    .where(
      and(
        eq(subscriptionPayment.id, paymentId),
        eq(subscriptionPayment.surplus, true),
        sql`${subscriptionPayment.surplusReviewedAt} is null`,
      ),
    )
    .returning({ id: subscriptionPayment.id });
  return updated.length > 0;
}

/**
 * Gives back, by itself, the second payment of a month that an overdue link had paid: the owner paid
 * the link while the recurring charge could still retry the same month, and the retry succeeded. This
 * is the only refund the platform makes without an operator, and it is narrow on purpose: an approved
 * recurring charge, flagged as the duplicate of a payment of an overdue link of the same month, not
 * refunded in any part and not looked at by anybody. It goes through `refundPayment` like every refund
 * (the mark, the bounded call, the settle window), with a token of its own so that it is made once
 * however many times a reconcile asks.
 */
export async function refundDuplicates(deps: SubscriptionDeps, tenantId: string): Promise<number> {
  if (!gatewayOf(deps)) return 0;
  const due = await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx.execute<{ id: string; amount_cents: string }>(sql`
      select p.id, p.amount_cents::text as amount_cents
        from subscription_payment p
       where p.purpose = 'charge' and p.surplus and p.surplus_reviewed_at is null
         and p.status = 'approved' and p.refunded_cents = 0
         and exists (
           select 1 from subscription_payment o
            where o.subscription_id = p.subscription_id and o.purpose = 'overdue'
              and o.credited and not o.surplus and o.period = p.period
              and o.status in ('approved', 'partially_refunded'))
       order by p.provider_created_at, p.id
       limit 5`);
    return rows.rows;
  });

  let refunded = 0;
  for (const payment of due) {
    const outcome = await refundPayment(deps, {
      tenantId,
      paymentId: payment.id,
      amountCents: Number(payment.amount_cents),
      actor: SYSTEM_ACTOR,
      requestedBy: 'system',
      clientToken: `${AUTOMATIC_REFUND_PREFIX}${payment.id}`,
      reason: 'duplicate_of_overdue_link',
    });
    if (outcome.status === 'refunded') refunded += 1;
  }
  return refunded;
}

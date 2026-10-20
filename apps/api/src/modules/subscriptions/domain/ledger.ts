import type { PaymentDescription, PaymentStatus } from '../application/ports.js';

import { periodBounds, periodOf } from './periods.js';

/**
 * How the payments the provider reports become entries of the subscription (subscriptions,
 * "Duplicate payment protection and refunds"). Pure: the payments the provider holds for the
 * subscription come in, with what is already recorded, and the operations to write come out.
 *
 * - A billing period is paid ONCE. The first approved payment of a period credits it; a later one
 *   for the same period (or an earlier one) is recorded as a SURPLUS, flagged for the operator, and
 *   does not move `paid_through`.
 * - What the provider says NOW is what counts, not the order notices arrived in: a payment never goes
 *   back to an earlier status (an old "pending" read after an "approved" changes nothing), and a
 *   notice delivered twice finds its row.
 * - The payments are worked in the order the provider made them, so the result of a pass does not
 *   depend on the order they were listed or discovered in.
 */

/** What a payment is for, derived from the reference the server gave it. */
export type PaymentPurpose =
  /** The monthly charge of the preapproval. */
  | 'charge'
  /** A one-off link for an overdue period (`due:` reference). */
  | 'overdue'
  /** A one-off link for the difference of a statement (`stmt:` reference). */
  | 'statement';

export function purposeOf(
  payment: Pick<PaymentDescription, 'linkId' | 'externalReference'>,
): PaymentPurpose {
  if (payment.linkId === undefined) return 'charge';
  return payment.externalReference.startsWith('stmt:') ? 'statement' : 'overdue';
}

export interface RecordedPayment {
  providerPaymentId: string;
  status: PaymentStatus;
  refundedCents: number;
  purpose: PaymentPurpose;
  /** The period this payment credited; null when it credited none. */
  period: string | null;
  surplus: boolean;
  /** The approval was already credited to the subscription (or flagged as a surplus). */
  credited: boolean;
}

export type LedgerOperation =
  | {
      type: 'insert';
      payment: PaymentDescription;
      purpose: PaymentPurpose;
      period: string | null;
      surplus: boolean;
      credited: boolean;
    }
  | {
      type: 'update';
      payment: PaymentDescription;
      /** Credits a payment that was known and was not approved before. */
      credit: { period: string | null; surplus: boolean } | null;
    };

export interface LedgerEffects {
  /** An approved payment that counts: the provider confirmed money for the subscription. */
  approvedCounted: boolean;
  /** The newest instant of an approval that counted in this pass, or null. */
  approvedCountedAt: Date | null;
  /** The newest instant of a rejected charge not seen before, or null. */
  rejectedChargeAt: Date | null;
  /** Payments recorded as a surplus in this pass. */
  surplusPaymentIds: string[];
  /** The new `paid_through`, or null when it does not move. */
  paidThrough: Date | null;
}

export interface LedgerPlan {
  operations: LedgerOperation[];
  effects: LedgerEffects;
}

const RANK: Record<PaymentStatus, number> = {
  pending: 0,
  approved: 1,
  rejected: 1,
  cancelled: 1,
  partially_refunded: 2,
  refunded: 3,
  charged_back: 3,
};

/** A status moves forward only: an older one read late is ignored. */
export function movesForward(from: PaymentStatus, to: PaymentStatus): boolean {
  return RANK[to] > RANK[from];
}

const approvedInstant = (payment: PaymentDescription) =>
  new Date(payment.approvedAt ?? payment.createdAt);

const isCredit = (status: PaymentStatus) =>
  status === 'approved' ||
  status === 'partially_refunded' ||
  status === 'refunded' ||
  status === 'charged_back';

function chronological(payments: readonly PaymentDescription[]): PaymentDescription[] {
  return [...payments].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.paymentId.localeCompare(b.paymentId),
  );
}

/**
 * Plans one pass over the payments the provider reports. `lastPaidPeriod` is the latest period a
 * recorded payment credited, `paidThrough` the current end of the covered time.
 */
export function planLedger(input: {
  payments: readonly PaymentDescription[];
  recorded: ReadonlyMap<string, RecordedPayment>;
  lastPaidPeriod: string | null;
  paidThrough: Date | null;
}): LedgerPlan {
  const operations: LedgerOperation[] = [];
  const effects: LedgerEffects = {
    approvedCounted: false,
    approvedCountedAt: null,
    rejectedChargeAt: null,
    surplusPaymentIds: [],
    paidThrough: null,
  };
  let lastPaid = input.lastPaidPeriod;
  let covered = input.paidThrough;

  /** Decides what an approval credits: a new period, nothing (a surplus), or nothing at all. */
  function credit(payment: PaymentDescription, purpose: PaymentPurpose) {
    if (purpose === 'statement') return { period: null, surplus: false };
    const period = periodOf(approvedInstant(payment));
    if (lastPaid !== null && period <= lastPaid) {
      effects.surplusPaymentIds.push(payment.paymentId);
      return { period, surplus: true };
    }
    lastPaid = period;
    const end = periodBounds(period).end;
    if (covered === null || end.getTime() > covered.getTime()) {
      covered = end;
      effects.paidThrough = end;
    }
    effects.approvedCounted = true;
    const at = approvedInstant(payment);
    if (effects.approvedCountedAt === null || at.getTime() > effects.approvedCountedAt.getTime()) {
      effects.approvedCountedAt = at;
    }
    return { period, surplus: false };
  }

  function noteRejection(payment: PaymentDescription, purpose: PaymentPurpose) {
    if (payment.status !== 'rejected' || purpose !== 'charge') return;
    const at = new Date(payment.createdAt);
    if (effects.rejectedChargeAt === null || at.getTime() > effects.rejectedChargeAt.getTime()) {
      effects.rejectedChargeAt = at;
    }
  }

  for (const payment of chronological(input.payments)) {
    const known = input.recorded.get(payment.paymentId);
    const purpose = purposeOf(payment);

    if (!known) {
      const approved = isCredit(payment.status);
      const credited = approved ? credit(payment, purpose) : { period: null, surplus: false };
      noteRejection(payment, purpose);
      operations.push({
        type: 'insert',
        payment,
        purpose,
        period: credited.period,
        surplus: credited.surplus,
        credited: approved,
      });
      continue;
    }

    // Known: only a step forward is written, and an approval that was not credited yet is credited now.
    const forward = movesForward(known.status, payment.status);
    const refundedMore = payment.refundedCents > known.refundedCents;
    const becameApproved = !known.credited && isCredit(payment.status);
    if (!forward && !refundedMore && !becameApproved) continue;
    if (forward && known.status !== 'rejected') noteRejection(payment, purpose);
    operations.push({
      type: 'update',
      payment: forward ? payment : { ...payment, status: known.status },
      credit: becameApproved ? credit(payment, known.purpose) : null,
    });
  }
  return { operations, effects };
}

import type { PaymentDescription, PaymentStatus } from '../application/ports.js';

import { periodBounds, periodOf } from './periods.js';

/**
 * How the payments the provider reports become entries of the subscription (subscriptions,
 * "Duplicate payment protection and refunds"). Pure: the payments the provider holds for the
 * subscription come in, with what is already recorded and what the platform owns, and the operations
 * to write come out.
 *
 * - A payment is credited only when it is OURS: a charge of the preapproval the subscription holds, or
 *   the payment of a link the platform made (same reference, same amount), in pesos. The provider is
 *   asked for payments by reference and by preapproval, and what it answers is never believed beyond
 *   that: a charge of a preapproval that was superseded is recorded as a surplus (it is the second
 *   charge of the same person), and anything else that is not ours is flagged for the operator and
 *   credits nothing (JD-S6 R1, A-W10).
 * - A billing period is paid ONCE. The first approved payment of a period credits it; a later one
 *   for the same period (or an earlier one) is recorded as a SURPLUS, flagged for the operator, and
 *   does not move `paid_through`.
 * - A payment that is first seen as already refunded or charged back is recorded and credits nothing:
 *   the money went back before the platform counted it (JD-S6 R1, B-T2).
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

/** What the platform owns of what the provider can answer: only these payments are ours. */
export interface LedgerOwnership {
  /** The preapproval the subscription charges through now. */
  preapprovalId: string | null;
  /** The preapprovals the subscription held before, or that were found alive after it gave them up. */
  earlierPreapprovalIds: ReadonlySet<string>;
  /** The links the platform made and the provider confirmed. */
  links: readonly { externalReference: string; amountCents: number; linkId: string | null }[];
}

/** Why a payment is flagged for the operator instead of credited. */
export type SurplusReason =
  /** A second approval for a period that was paid already. */
  | 'duplicate_period'
  /** A recurring charge for a period that an overdue link paid: the same period, paid twice. */
  | 'duplicate_of_overdue_link'
  /** A charge of a preapproval the subscription no longer holds. */
  | 'superseded_preapproval'
  /** A payment of a preapproval the platform never made for this subscription. */
  | 'foreign_preapproval'
  /** A payment of a link the platform did not make (or for another amount). */
  | 'foreign_link'
  /** A payment that is not in pesos. */
  | 'foreign_currency';

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
  /** The same payments with the reason each was flagged for. */
  flagged: { paymentId: string; reason: SurplusReason }[];
  /** Payments that are skipped and not recorded at all (no amount): the operator is told. */
  skipped: { paymentId: string; reason: 'no_amount' }[];
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

/** An approval that still stands and can credit a period: money in, and not (all) given back. */
const isCreditable = (status: PaymentStatus) =>
  status === 'approved' || status === 'partially_refunded';

/** Money that went back before the platform counted it. */
const isGivenBack = (status: PaymentStatus) => status === 'refunded' || status === 'charged_back';

function chronological(payments: readonly PaymentDescription[]): PaymentDescription[] {
  return [...payments].sort(
    (a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() ||
      a.paymentId.localeCompare(b.paymentId),
  );
}

type Standing = { kind: 'owned' } | { kind: 'skip' } | { kind: 'not_ours'; reason: SurplusReason };

/** Whether a payment the provider reports is ours. Never inferred from its status. */
export function standingOf(payment: PaymentDescription, ownership: LedgerOwnership): Standing {
  // A payment with no amount credits nothing and cannot be stored (the database refuses it).
  if (payment.amountCents <= 0) return { kind: 'skip' };
  // The currency is checked at run time: the type says `ARS`, the wire does not.
  if ((payment.currency as string) !== 'ARS')
    return { kind: 'not_ours', reason: 'foreign_currency' };

  if (payment.linkId !== undefined) {
    const made = ownership.links.some(
      (link) =>
        link.externalReference === payment.externalReference &&
        link.amountCents === payment.amountCents &&
        (link.linkId === null || link.linkId === payment.linkId),
    );
    return made ? { kind: 'owned' } : { kind: 'not_ours', reason: 'foreign_link' };
  }
  if (payment.preapprovalId === undefined) {
    return { kind: 'not_ours', reason: 'foreign_preapproval' };
  }
  if (payment.preapprovalId === ownership.preapprovalId) return { kind: 'owned' };
  return {
    kind: 'not_ours',
    reason: ownership.earlierPreapprovalIds.has(payment.preapprovalId)
      ? 'superseded_preapproval'
      : 'foreign_preapproval',
  };
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
  ownership: LedgerOwnership;
}): LedgerPlan {
  const operations: LedgerOperation[] = [];
  const effects: LedgerEffects = {
    approvedCounted: false,
    approvedCountedAt: null,
    rejectedChargeAt: null,
    surplusPaymentIds: [],
    flagged: [],
    skipped: [],
    paidThrough: null,
  };
  let lastPaid = input.lastPaidPeriod;
  let covered = input.paidThrough;
  /** How each period that is paid was paid, so a duplicate of a link payment can be told. */
  const paidBy = new Map<string, PaymentPurpose>();
  for (const known of input.recorded.values()) {
    if (known.credited && !known.surplus && known.period !== null) {
      paidBy.set(known.period, known.purpose);
    }
  }

  function flag(payment: PaymentDescription, reason: SurplusReason) {
    effects.surplusPaymentIds.push(payment.paymentId);
    effects.flagged.push({ paymentId: payment.paymentId, reason });
  }

  /** Decides what an approval credits: a new period, nothing (a surplus), or nothing at all. */
  function credit(payment: PaymentDescription, purpose: PaymentPurpose) {
    if (purpose === 'statement') return { period: null, surplus: false };
    const period = periodOf(approvedInstant(payment));
    if (lastPaid !== null && period <= lastPaid) {
      flag(
        payment,
        purpose === 'charge' && paidBy.get(period) === 'overdue'
          ? 'duplicate_of_overdue_link'
          : 'duplicate_period',
      );
      return { period, surplus: true };
    }
    lastPaid = period;
    paidBy.set(period, purpose);
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

  /**
   * A rejected charge counts only when nothing newer was paid: a charge that failed in a month that a
   * payment already covers (this pass or an earlier one) is history, not a failure.
   */
  function noteRejection(payment: PaymentDescription, purpose: PaymentPurpose) {
    if (payment.status !== 'rejected' || purpose !== 'charge') return;
    const at = new Date(payment.createdAt);
    if (lastPaid !== null && periodOf(at) <= lastPaid) return;
    if (effects.rejectedChargeAt === null || at.getTime() > effects.rejectedChargeAt.getTime()) {
      effects.rejectedChargeAt = at;
    }
  }

  for (const payment of chronological(input.payments)) {
    const known = input.recorded.get(payment.paymentId);
    const purpose = purposeOf(payment);

    if (!known) {
      const standing = standingOf(payment, input.ownership);
      if (standing.kind === 'skip') {
        effects.skipped.push({ paymentId: payment.paymentId, reason: 'no_amount' });
        continue;
      }
      if (standing.kind === 'not_ours') {
        // Money of a payer that came in through a door the platform does not own: it is recorded
        // as a surplus for the operator to look at, and credits nothing. What never became money
        // (pending, rejected, cancelled) or went back at once is not recorded at all.
        if (!isCreditable(payment.status)) continue;
        flag(payment, standing.reason);
        operations.push({
          type: 'insert',
          payment,
          purpose,
          period: null,
          surplus: true,
          credited: true,
        });
        continue;
      }
      if (isCreditable(payment.status)) {
        const credited = credit(payment, purpose);
        operations.push({
          type: 'insert',
          payment,
          purpose,
          period: credited.period,
          surplus: credited.surplus,
          credited: true,
        });
        continue;
      }
      noteRejection(payment, purpose);
      operations.push({
        type: 'insert',
        payment,
        purpose,
        period: null,
        surplus: false,
        // Given back before it was counted: decided, and it credits nothing.
        credited: isGivenBack(payment.status),
      });
      continue;
    }

    // Known: only a step forward is written, and an approval that was not credited yet is credited now.
    const forward = movesForward(known.status, payment.status);
    const refundedMore = payment.refundedCents > known.refundedCents;
    const becameApproved = !known.credited && isCreditable(payment.status);
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

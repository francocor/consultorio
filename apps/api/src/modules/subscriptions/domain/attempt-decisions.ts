import type {
  PaymentDescription,
  PaymentLinkDescription,
  PreapprovalDescription,
  RefundDescription,
} from '../application/ports.js';

/**
 * What to do with a write to the payments provider whose outcome the caller does not know (a timeout,
 * an abort, a lost answer, a crash after the mark). The provider may NOT honour idempotency keys, and
 * a request that the caller gave up on may still land. So the caller never infers: it asks the
 * provider (`find*`, `get*`) and these functions decide, from what the provider says and nothing
 * else, whether to:
 *
 * - `adopt` what the provider holds (only when EVERY identifying field is equal to what was asked);
 * - `release` the attempt (the provider holds nothing, and the settle window passed, so nothing in
 *   flight can still land: it is safe to send again);
 * - `wait` (the provider cannot be asked now, or the window is still open);
 * - `park` it for a person (more than one resource could be ours, or one that is not what was asked
 *   carries our reference): never pick one.
 *
 * Pure: the instants and the answers come in, a verdict goes out.
 */

export type ParkReason = 'ambiguous_preapproval' | 'identity_mismatch' | 'unexpected_state';
export type WaitReason = 'in_flight' | 'unavailable';

export type Verdict<A> =
  | { kind: 'adopt'; resource: A }
  | { kind: 'release' }
  | { kind: 'wait'; reason: WaitReason }
  | { kind: 'park'; reason: ParkReason };

export interface Timing {
  now: Date;
  /** The instant before which a request that was given up on may still land at the provider. */
  settleUntil: Date;
}

const windowOpen = (timing: Timing) => timing.now.getTime() < timing.settleUntil.getTime();

// Preapprovals --------------------------------------------------------------------------------

export interface PreapprovalAsked {
  externalReference: string;
  payerEmail: string;
  amountCents: number;
}

/** Every identifying field of a preapproval equals what was asked. */
export function preapprovalMatches(
  asked: PreapprovalAsked,
  found: PreapprovalDescription,
): boolean {
  return (
    found.externalReference === asked.externalReference &&
    found.payerEmail.toLowerCase() === asked.payerEmail.toLowerCase() &&
    found.amountCents === asked.amountCents
  );
}

export function decidePreapprovalAttempt(input: {
  asked: PreapprovalAsked;
  /** What the search by reference answered; `'unavailable'` when the provider could not be asked. */
  found: readonly PreapprovalDescription[] | 'unavailable';
  timing: Timing;
}): Verdict<PreapprovalDescription> {
  const { found } = input;
  if (found === 'unavailable') return { kind: 'wait', reason: 'unavailable' };
  if (found.length === 0) {
    return windowOpen(input.timing) ? { kind: 'wait', reason: 'in_flight' } : { kind: 'release' };
  }
  const [only] = found;
  if (found.length === 1 && only && preapprovalMatches(input.asked, only)) {
    return { kind: 'adopt', resource: only };
  }
  const matching = found.filter((entry) => preapprovalMatches(input.asked, entry));
  return {
    kind: 'park',
    reason: matching.length === 0 ? 'identity_mismatch' : 'ambiguous_preapproval',
  };
}

// Payment links -------------------------------------------------------------------------------

export function linkMatches(asked: PreapprovalAsked, found: PaymentLinkDescription): boolean {
  return (
    found.externalReference === asked.externalReference &&
    found.payerEmail.toLowerCase() === asked.payerEmail.toLowerCase() &&
    found.amountCents === asked.amountCents
  );
}

export function decideLinkAttempt(input: {
  asked: PreapprovalAsked;
  found: readonly PaymentLinkDescription[] | 'unavailable';
  timing: Timing;
}): Verdict<PaymentLinkDescription> {
  const { found } = input;
  if (found === 'unavailable') return { kind: 'wait', reason: 'unavailable' };
  if (found.length === 0) {
    return windowOpen(input.timing) ? { kind: 'wait', reason: 'in_flight' } : { kind: 'release' };
  }
  const [only] = found;
  if (found.length === 1 && only && linkMatches(input.asked, only)) {
    return { kind: 'adopt', resource: only };
  }
  const matching = found.filter((entry) => linkMatches(input.asked, entry));
  return {
    kind: 'park',
    reason: matching.length === 0 ? 'identity_mismatch' : 'ambiguous_preapproval',
  };
}

// A change of amount --------------------------------------------------------------------------

/**
 * After an unknown change of amount the preapproval is read: it holds the new amount (the change
 * landed: adopt), the old one and the window passed (it did not and cannot: release), the old one
 * and the window is open (wait), or an amount that is neither (somebody else changed it: park).
 */
export function decideAmountChangeAttempt(input: {
  previousCents: number;
  askedCents: number;
  found: Pick<PreapprovalDescription, 'amountCents' | 'status'> | 'unavailable' | 'unknown';
  timing: Timing;
}): Verdict<null> {
  const { found } = input;
  if (found === 'unavailable') return { kind: 'wait', reason: 'unavailable' };
  if (found === 'unknown') return { kind: 'park', reason: 'unexpected_state' };
  if (found.amountCents === input.askedCents) return { kind: 'adopt', resource: null };
  if (found.amountCents === input.previousCents) {
    return windowOpen(input.timing) ? { kind: 'wait', reason: 'in_flight' } : { kind: 'release' };
  }
  return { kind: 'park', reason: 'unexpected_state' };
}

// A cancellation ------------------------------------------------------------------------------

export function decideCancelAttempt(input: {
  found: Pick<PreapprovalDescription, 'status'> | 'unavailable' | 'unknown';
  timing: Timing;
}): Verdict<null> {
  const { found } = input;
  if (found === 'unavailable') return { kind: 'wait', reason: 'unavailable' };
  if (found === 'unknown') return { kind: 'park', reason: 'unexpected_state' };
  if (found.status === 'cancelled') return { kind: 'adopt', resource: null };
  return windowOpen(input.timing) ? { kind: 'wait', reason: 'in_flight' } : { kind: 'release' };
}

// A refund ------------------------------------------------------------------------------------

/**
 * A refund is not safe to repeat blindly: after an unknown outcome the payment is read and compared
 * with the refunds it had BEFORE the call. Exactly one new refund of the amount that was asked: it
 * landed (adopt). None, and the window passed: it did not (release). More than one new refund, or one
 * of another amount: park.
 */
export function decideRefundAttempt(input: {
  refundIdsBefore: readonly string[];
  askedCents: number;
  found: Pick<PaymentDescription, 'refunds'> | 'unavailable' | 'unknown';
  timing: Timing;
}): Verdict<RefundDescription> {
  const { found } = input;
  if (found === 'unavailable') return { kind: 'wait', reason: 'unavailable' };
  if (found === 'unknown') return { kind: 'park', reason: 'unexpected_state' };
  const before = new Set(input.refundIdsBefore);
  const added = found.refunds.filter((refund) => !before.has(refund.refundId));
  if (added.length === 0) {
    return windowOpen(input.timing) ? { kind: 'wait', reason: 'in_flight' } : { kind: 'release' };
  }
  const [only] = added;
  if (added.length === 1 && only && only.amountCents === input.askedCents) {
    return { kind: 'adopt', resource: only };
  }
  return { kind: 'park', reason: 'unexpected_state' };
}

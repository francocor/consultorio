import { TENANT_STATUS_OF_SUBSCRIPTION, type SubscriptionStatus } from '@consultorio/contracts';

/**
 * The lifecycle of the subscription of an organization (subscriptions, "Tenant billing states";
 * design section 7), as a pure function. The one rule that matters: a state changes only because
 * the PROVIDER CONFIRMED something (an authorization, an approved or a rejected payment), because a
 * DATE arrived (the end of the trial, of the grace, of the paid period) or because the OWNER asked
 * (cancel, reactivate). The absence of a confirmation is not an event: an outage, a timeout or an
 * outcome nobody knows is `unconfirmed`, and it changes nothing, so a provider that is down can
 * never advance a dunning, cancel or regress a state.
 *
 * ```
 * trial -> active | past_due | cancelling
 * active -> past_due | cancelling
 * past_due -> active | read_only | cancelling
 * read_only -> active | cancelling
 * cancelling -> active | trial | cancelled
 * cancelled -> (nothing)
 * ```
 *
 * The same table is repeated in the database (`subscription_guard`, migration 0610) as a backstop.
 */

const DAY_MS = 86_400_000;

export const ALLOWED_TRANSITIONS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  trial: ['active', 'past_due', 'cancelling'],
  active: ['past_due', 'cancelling'],
  past_due: ['active', 'read_only', 'cancelling'],
  read_only: ['active', 'cancelling'],
  cancelling: ['active', 'trial', 'cancelled'],
  cancelled: [],
};

/** What the machine needs to know about a subscription. */
export interface SubscriptionFacts {
  status: SubscriptionStatus;
  trialEndsAt: Date;
  graceEndsAt: Date | null;
  paidThrough: Date | null;
  /** The provider last confirmed that the authorization to charge is in force. */
  authorized: boolean;
}

export type SubscriptionEvent =
  // The provider confirmed what the payer authorized.
  | { type: 'authorization_confirmed' }
  // The provider confirmed an approved payment that counts (not a surplus).
  | { type: 'payment_approved' }
  // The provider confirmed that a recurring charge was rejected, at this instant.
  | { type: 'payment_rejected'; at: Date }
  // Dates.
  | { type: 'trial_ended' }
  | { type: 'grace_expired' }
  | { type: 'coverage_ended' }
  | { type: 'period_ended' }
  // The owner.
  | { type: 'cancel_requested' }
  | { type: 'reactivated' }
  // An outage, a timeout, a lost answer: nothing is known, so nothing changes.
  | { type: 'unconfirmed' };

export interface TransitionContext {
  now: Date;
  /** The length of the grace of the plan, in days. */
  graceDays: number;
}

export type NotChangedReason = 'not_due' | 'not_allowed' | 'no_effect';

export interface Transition {
  changed: boolean;
  from: SubscriptionStatus;
  to: SubscriptionStatus;
  /** The value `grace_ends_at` has after the event. */
  graceEndsAt: Date | null;
  /** The value `paid_through` has after the event. */
  paidThrough: Date | null;
  /** What `tenant.status` is for the new state (it is derived, never set on its own). */
  tenantStatus: 'active' | 'read_only' | 'cancelled';
  /** The subscription reached `cancelled`: say so to retention, in the same transaction. */
  publishCancelled: boolean;
  /** Why nothing changed. */
  reason?: NotChangedReason;
}

/** The state of the organization that follows from the subscription (design section 7). */
export function derivedTenantStatus(
  status: SubscriptionStatus,
): 'active' | 'read_only' | 'cancelled' {
  return TENANT_STATUS_OF_SUBSCRIPTION[status];
}

/** The end of what is covered: the paid period, or the trial when nothing was ever paid. */
export function coverageEnd(facts: Pick<SubscriptionFacts, 'paidThrough' | 'trialEndsAt'>): Date {
  const paid = facts.paidThrough?.getTime() ?? Number.NEGATIVE_INFINITY;
  return new Date(Math.max(paid, facts.trialEndsAt.getTime()));
}

const addDays = (from: Date, days: number) => new Date(from.getTime() + days * DAY_MS);

function unchanged(facts: SubscriptionFacts, reason: NotChangedReason): Transition {
  return {
    changed: false,
    from: facts.status,
    to: facts.status,
    graceEndsAt: facts.graceEndsAt,
    paidThrough: facts.paidThrough,
    tenantStatus: derivedTenantStatus(facts.status),
    publishCancelled: false,
    reason,
  };
}

function moved(
  facts: SubscriptionFacts,
  to: SubscriptionStatus,
  extra: Partial<Pick<Transition, 'graceEndsAt' | 'paidThrough' | 'publishCancelled'>> = {},
): Transition {
  return {
    changed: to !== facts.status,
    from: facts.status,
    to,
    graceEndsAt: extra.graceEndsAt === undefined ? facts.graceEndsAt : extra.graceEndsAt,
    paidThrough: extra.paidThrough === undefined ? facts.paidThrough : extra.paidThrough,
    tenantStatus: derivedTenantStatus(to),
    publishCancelled: extra.publishCancelled ?? false,
  };
}

/**
 * What an event does to a subscription. It never throws and never leaves the table of allowed
 * changes; an event that does not apply to the state leaves it as it is and says why.
 */
export function transition(
  facts: SubscriptionFacts,
  event: SubscriptionEvent,
  context: TransitionContext,
): Transition {
  const { status } = facts;
  const now = context.now.getTime();

  switch (event.type) {
    case 'unconfirmed':
      return unchanged(facts, 'no_effect');

    case 'authorization_confirmed':
      if (status === 'trial') return moved(facts, 'active');
      // The owner authorized again while cancelling: the cancellation is taken back.
      if (status === 'cancelling' && coverageEnd(facts).getTime() > now) {
        return moved(facts, 'active');
      }
      return unchanged(facts, 'no_effect');

    case 'payment_approved':
      if (status === 'trial') return moved(facts, 'active');
      if (status === 'past_due' || status === 'read_only') {
        return moved(facts, 'active', { graceEndsAt: null });
      }
      return unchanged(facts, 'no_effect');

    case 'payment_rejected':
      if (status !== 'active') return unchanged(facts, 'no_effect');
      return moved(facts, 'past_due', {
        graceEndsAt: addDays(event.at, context.graceDays),
      });

    case 'trial_ended':
      if (status !== 'trial') return unchanged(facts, 'no_effect');
      if (facts.trialEndsAt.getTime() > now) return unchanged(facts, 'not_due');
      return moved(facts, 'past_due', {
        graceEndsAt: addDays(facts.trialEndsAt, context.graceDays),
      });

    case 'grace_expired':
      if (status !== 'past_due') return unchanged(facts, 'no_effect');
      if (facts.graceEndsAt === null || facts.graceEndsAt.getTime() > now) {
        return unchanged(facts, 'not_due');
      }
      return moved(facts, 'read_only');

    case 'coverage_ended': {
      if (status !== 'active' || facts.authorized) return unchanged(facts, 'no_effect');
      const end = coverageEnd(facts);
      if (end.getTime() > now) return unchanged(facts, 'not_due');
      return moved(facts, 'past_due', { graceEndsAt: addDays(end, context.graceDays) });
    }

    case 'period_ended': {
      if (status !== 'cancelling') return unchanged(facts, 'no_effect');
      if (coverageEnd(facts).getTime() > now) return unchanged(facts, 'not_due');
      return moved(facts, 'cancelled', { publishCancelled: true });
    }

    case 'cancel_requested': {
      if (status === 'cancelled') return unchanged(facts, 'not_allowed');
      if (status === 'cancelling') return unchanged(facts, 'no_effect');
      // Service continues until the end of what is covered; when nothing is, the cancellation
      // takes effect now.
      const end = status === 'trial' ? facts.trialEndsAt : (facts.paidThrough ?? context.now);
      const covered = end.getTime() > now ? end : context.now;
      const paidThrough =
        facts.paidThrough !== null && facts.paidThrough.getTime() > covered.getTime()
          ? facts.paidThrough
          : covered;
      return moved(facts, 'cancelling', { graceEndsAt: null, paidThrough });
    }

    case 'reactivated': {
      if (status !== 'cancelling') return unchanged(facts, 'no_effect');
      if (coverageEnd(facts).getTime() <= now) return unchanged(facts, 'not_allowed');
      if (facts.authorized) return moved(facts, 'active');
      if (facts.trialEndsAt.getTime() > now) return moved(facts, 'trial');
      return unchanged(facts, 'not_allowed');
    }
  }
}

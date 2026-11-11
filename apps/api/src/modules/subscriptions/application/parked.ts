import { and, eq, ne, sql } from 'drizzle-orm';

import { subscriptionAttempt, type AttentionReason } from '../../../db/schema/subscriptions.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';

import { clearAttention } from './attempts.js';
import { reauthorizationSettled } from './collection.js';
import { SUBSCRIPTION_RECONCILE_JOB } from './job-names.js';
import { settleWindowOf, type SubscriptionDeps } from './provider.js';
import { markSurplusReviewed } from './refunds.js';
import { lockSubscription } from './store.js';

export type ResolveParkedOutcome =
  | { status: 'resolved'; was: AttentionReason; released: number; reopened: number }
  | { status: 'not_parked' }
  /** The cause is still there (an amount the owner has to authorize): it clears itself when it settles. */
  | { status: 'cause_persists' };

export interface ResolveParkedInput {
  tenantId: string;
  /** The operator, as the trail knows them. */
  actor: AuditActor;
}

/**
 * The way out of a parked subscription (JD-S6 R1, C1): the operator looked at what the provider holds
 * and decided, and the decision is on the record with their id and their reason.
 *
 * A subscription is parked when more than one resource at the provider could be ours, or one is not
 * what was asked, and from then on nothing is sent for it until a person decides. This is that
 * decision, and it is narrow on purpose:
 *
 * - it releases the parked requests for a PREAPPROVAL (the platform treats them as abandoned, so the
 *   reference they carried is searched like any other the platform gave up on), and clears the cause;
 * - a parked refund, payment link, change of amount or cancellation is NOT released: money may have
 *   moved under it, and a release lets the same request be sent again. It goes back to `marked` with a
 *   new settle window, so the reconcile asks the provider about it (by reference, or the payment for a
 *   refund) and decides adopt, release or park exactly as it would have the first time (JD-S6 R2-4);
 * - it NEVER adopts anything and never sends anything. A preapproval that was found under a reference
 *   of this subscription and is not the one it holds is cancelled by the next reconcile, which is
 *   queued here, so what the operator decides is "start from what the provider confirms", not "pick
 *   one of these";
 * - a parked state that comes from the owner having to authorize an amount (`reauthorization_needed`)
 *   is not for the operator to waive: it clears by itself when the charge lands or the owner
 *   authorizes the right amount, and until then this says so.
 */
export async function resolveParked(
  deps: SubscriptionDeps,
  input: ResolveParkedInput,
): Promise<ResolveParkedOutcome> {
  return deps.withTenant({ tenantId: input.tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const now = deps.clock();
    const row = await lockSubscription(tx);
    if (row === null || row.attentionReason === null) return { status: 'not_parked' as const };
    const was = row.attentionReason as AttentionReason;
    if (was === 'reauthorization_needed' && !(await reauthorizationSettled(tx, row))) {
      return { status: 'cause_persists' as const };
    }

    const released = await tx
      .update(subscriptionAttempt)
      .set({ state: 'released', resolvedAt: now, message: 'resolved_by_operator' })
      .where(
        and(
          eq(subscriptionAttempt.subscriptionId, row.id),
          eq(subscriptionAttempt.state, 'parked'),
          eq(subscriptionAttempt.kind, 'preapproval'),
        ),
      )
      .returning({ id: subscriptionAttempt.id });
    // Anything else that was parked may have moved money: the provider is asked again before it is
    // settled. The pin only grows (the database refuses to shorten it).
    const until = new Date(
      now.getTime() + settleWindowOf(deps) + (deps.providerTimeoutMs ?? 20_000),
    );
    const reopened = await tx
      .update(subscriptionAttempt)
      .set({
        state: 'marked',
        outcomeUnknown: true,
        resolvedAt: null,
        message: 'reopened_by_operator',
        settleUntil: sql`greatest(${subscriptionAttempt.settleUntil}, ${until.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(subscriptionAttempt.subscriptionId, row.id),
          eq(subscriptionAttempt.state, 'parked'),
          ne(subscriptionAttempt.kind, 'preapproval'),
        ),
      )
      .returning({ id: subscriptionAttempt.id });
    await clearAttention(tx, row.id);
    await audit(tx, {
      action: 'subscription.parked_resolved',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'subscription',
      resourceId: row.id,
      // The operator's own words go into the platform trail (the console writes them there); the trail
      // of the organization keeps a code and the counts.
      reason: 'operator_decision',
      metadata: { attention: was, released: released.length, reopened: reopened.length },
    });
    // The reconcile asks the provider what it holds now and cancels what the platform has given up on.
    await deps.jobs?.enqueue(
      tx,
      SUBSCRIPTION_RECONCILE_JOB,
      { tenantId: input.tenantId },
      { singletonKey: input.tenantId, singletonSeconds: 1 },
    );
    return {
      status: 'resolved' as const,
      was,
      released: released.length,
      reopened: reopened.length,
    };
  });
}

/**
 * The operator looked at a payment flagged as a surplus and left it as it is (or refunded it, which
 * marks it by itself): it stops counting as an unreviewed item. Audited with the operator and why.
 */
export async function reviewSurplus(
  deps: SubscriptionDeps,
  input: ResolveParkedInput & { paymentId: string },
): Promise<'reviewed' | 'not_flagged'> {
  return deps.withTenant({ tenantId: input.tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const row = await lockSubscription(tx);
    if (!row) return 'not_flagged' as const;
    const reviewed = await markSurplusReviewed(tx, input.paymentId, deps.clock());
    if (!reviewed) return 'not_flagged' as const;
    await audit(tx, {
      action: 'subscription.surplus_reviewed',
      outcome: 'allow',
      actor: input.actor,
      resourceType: 'subscription',
      resourceId: row.id,
      reason: 'operator_decision',
      metadata: { paymentId: input.paymentId },
    });
    return 'reviewed' as const;
  });
}

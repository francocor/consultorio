import { and, eq } from 'drizzle-orm';

import { subscription, subscriptionAttempt } from '../../../db/schema/subscriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';

import { blocksProvider, clearAttention } from './attempts.js';
import { SYSTEM_ACTOR } from './common.js';
import { cancelLivePreapprovals } from './preapprovals.js';
import { gatewayOf, type SubscriptionDeps } from './provider.js';
import { findSubscription, lockSubscription } from './store.js';

export type CancelAtProviderOutcome = 'nothing' | 'cancelled' | 'unavailable' | 'in_progress';

/**
 * Stops the charges at the provider for a subscription that is cancelling (or ended). Cancelling is a
 * write, so every preapproval it stops has a mark, a bounded call and an answer
 * (`preapprovals.ts`), and an unknown outcome is settled by reading that preapproval.
 *
 * It cancels EVERY live preapproval of the subscription the platform can find, not only the one it
 * holds: a preapproval that was paused, one it asked for earlier and one that landed late all charge
 * (JD-S6 R1, C2). It works while the subscription is parked for a person: a parked subscription is
 * exactly the one that must not keep charging an organization that asked to leave, and a preapproval
 * the platform could not identify is searched by the reference it asked with (JD-S6 R1, C1).
 *
 * `settle` reads and decides a cancellation whose outcome was not known once its window is over (the
 * clock of the dates passes the reconcile; the owner's own cancel does not wait for one).
 *
 * The authorization becomes `none` only when none is left. Until then the subscription stays
 * `cancelling`, and the end of the paid period does not turn it into `cancelled`.
 */
export async function cancelAtProvider(
  deps: SubscriptionDeps,
  tenantId: string,
  options: { settle?: () => Promise<void> } = {},
): Promise<CancelAtProviderOutcome> {
  if (!gatewayOf(deps)) return 'unavailable';
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, work);

  const before = await as(async (tx) => {
    const row = await findSubscription(tx);
    if (!row) return null;
    // Parked creations: the provider may hold a preapproval the platform never adopted.
    const [parked] = await tx
      .select({ id: subscriptionAttempt.id })
      .from(subscriptionAttempt)
      .where(
        and(
          eq(subscriptionAttempt.subscriptionId, row.id),
          eq(subscriptionAttempt.kind, 'preapproval'),
          eq(subscriptionAttempt.state, 'parked'),
        ),
      )
      .limit(1);
    return {
      status: row.status,
      authorization: row.authorizationState,
      parked: parked !== undefined,
    };
  });
  if (!before) return 'nothing';
  if (before.status !== 'cancelling' && before.status !== 'cancelled') return 'nothing';
  if (before.authorization === 'none' && !before.parked) return 'nothing';

  const swept = await cancelLivePreapprovals(deps, tenantId, {
    why: 'cancelling',
    includeParked: true,
    waitForCreation: true,
    ...(options.settle ? { settle: options.settle } : {}),
  });
  if (swept.status === 'in_progress') return 'in_progress';
  if (swept.status !== 'clear') return 'unavailable';

  return as(async (tx): Promise<CancelAtProviderOutcome> => {
    const now = deps.clock();
    const row = await lockSubscription(tx);
    if (!row) return 'nothing';
    if (row.status !== 'cancelling' && row.status !== 'cancelled') return 'nothing';
    let changed = false;
    if (row.authorizationState !== 'none') {
      await tx
        .update(subscription)
        .set({ authorizationState: 'none', version: row.version + 1 })
        .where(eq(subscription.id, row.id));
      changed = true;
    }
    // Everything the provider held under a request that was parked is now cancelled, so there is
    // nothing left for a person to decide: the parked requests are released and the cause is cleared
    // (JD-S6 R1, C1: cancelling is a way out of a parked subscription).
    const released = await tx
      .update(subscriptionAttempt)
      .set({ state: 'released', resolvedAt: now, message: 'cancelled_with_the_subscription' })
      .where(
        and(
          eq(subscriptionAttempt.subscriptionId, row.id),
          eq(subscriptionAttempt.kind, 'preapproval'),
          eq(subscriptionAttempt.state, 'parked'),
        ),
      )
      .returning({ id: subscriptionAttempt.id });
    if (released.length > 0) changed = true;
    // A write of another kind that is parked (a refund nobody could tell the outcome of) still waits
    // for a person, and so does the cause.
    const [stillParked] = await tx
      .select({ id: subscriptionAttempt.id })
      .from(subscriptionAttempt)
      .where(
        and(
          eq(subscriptionAttempt.subscriptionId, row.id),
          eq(subscriptionAttempt.state, 'parked'),
        ),
      )
      .limit(1);
    if (blocksProvider(row) && stillParked === undefined) {
      await clearAttention(tx, row.id);
      await audit(tx, {
        action: 'subscription.state_changed',
        outcome: 'allow',
        actor: SYSTEM_ACTOR,
        resourceType: 'subscription',
        resourceId: row.id,
        reason: 'attention_cleared',
        metadata: {
          from: row.status,
          to: row.status,
          attention: 'cleared',
          cause: row.attentionReason,
        },
      });
      changed = true;
    }
    return changed ? 'cancelled' : 'nothing';
  });
}

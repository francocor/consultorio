import { eq } from 'drizzle-orm';

import { subscription } from '../../../db/schema/subscriptions.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';

import {
  lockAttempt,
  markAttempt,
  nextAttemptNumber,
  noteUnknownOutcome,
  openAttempts,
  resolveAttempt,
} from './attempts.js';
import type { CancelPreapprovalResult } from './ports.js';
import { UNKNOWN_OUTCOME, callWithin, gatewayOf, type SubscriptionDeps } from './provider.js';
import { lockSubscription } from './store.js';

export type CancelAtProviderOutcome = 'nothing' | 'cancelled' | 'unavailable' | 'in_progress';

/**
 * Stops the charges at the provider for a subscription that is cancelling (or ended). It is a write,
 * so it has a mark, a bounded call and an answer; cancelling a preapproval is its own undo-proof (the
 * provider answers the same for a cancelled one), and after an unknown outcome the reconcile reads the
 * preapproval and either adopts the cancellation or, after the settle window, tries again.
 */
export async function cancelAtProvider(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<CancelAtProviderOutcome> {
  const gateway = gatewayOf(deps);
  if (!gateway) return 'unavailable';
  const as2 = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, work);

  const planned = await as2(async (tx) => {
    const row = await lockSubscription(tx);
    if (!row || row.providerPreapprovalId === null) return null;
    if (row.status !== 'cancelling' && row.status !== 'cancelled') return null;
    if (row.authorizationState === 'none' || row.authorizationState === 'lost') return null;
    if (row.attentionReason !== null) return 'in_progress' as const;
    const now = deps.clock();
    const open = (await openAttempts(tx, row.id)).filter((attempt) => attempt.kind === 'cancel');
    if (open.length > 0) return 'in_progress' as const;
    const number = await nextAttemptNumber(tx, row.id, 'cancel');
    const attempt = await markAttempt(tx, {
      subscriptionId: row.id,
      kind: 'cancel',
      externalReference: `cancel:${row.id}:${String(number)}`,
      now,
      settleWindowMs: gateway.settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
    });
    return {
      attemptId: attempt.id,
      key: attempt.idempotencyKey,
      preapprovalId: row.providerPreapprovalId,
    };
  });
  if (planned === null) return 'nothing';
  if (planned === 'in_progress') return 'in_progress';

  const sent = await callWithin(
    deps,
    (signal) => gateway.cancelPreapproval(planned.preapprovalId, planned.key, signal),
    UNKNOWN_OUTCOME as CancelPreapprovalResult,
  );
  const timedOut = sent.timedOut || sent.threw;

  return as2(async (tx) => {
    const now = deps.clock();
    const row = await lockSubscription(tx);
    const attempt = await lockAttempt(tx, planned.attemptId);
    if (!row || !attempt || attempt.state !== 'marked') return 'in_progress';
    const answer = sent.value;
    if (answer.status === 'cancelled') {
      await resolveAttempt(tx, attempt, {
        state: 'confirmed',
        resourceId: planned.preapprovalId,
        now,
      });
      await tx
        .update(subscription)
        .set({ authorizationState: 'none', version: row.version + 1 })
        .where(eq(subscription.id, row.id));
      return 'cancelled';
    }
    if (answer.status === 'rejected') {
      await resolveAttempt(tx, attempt, { state: 'rejected', now, message: answer.message });
      return 'unavailable';
    }
    if (!answer.outcomeUnknown && !timedOut) {
      await resolveAttempt(tx, attempt, { state: 'released', now, message: answer.message });
    } else {
      await noteUnknownOutcome(tx, attempt.id, answer.message);
    }
    return 'unavailable';
  });
}

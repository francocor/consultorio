import { eq } from 'drizzle-orm';

import {
  subscription,
  subscriptionAttempt,
  type SubscriptionAttemptRow,
} from '../../../db/schema/subscriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';

import {
  blocksProvider,
  lockAttempt,
  markAttempt,
  nextAttemptNumber,
  noteUnknownOutcome,
  openAttempts,
  parkSubscription,
  resolveAttempt,
} from './attempts.js';
import { SYSTEM_ACTOR } from './common.js';
import type { CancelPreapprovalResult, PaymentsGateway, PreapprovalDescription } from './ports.js';
import {
  UNKNOWN_OUTCOME,
  callWithin,
  gatewayOf,
  settleWindowOf,
  type Read,
  type SubscriptionDeps,
} from './provider.js';
import { findSubscription, lockSubscription } from './store.js';

/**
 * Every preapproval the platform ever asked for is an authorization to charge the payer every month,
 * and a provider that is not idempotent, pauses and resumes preapprovals and lets a request land after
 * the caller gave up can hold MORE THAN ONE live one for a subscription. Two live ones charge twice,
 * and nobody sees it unless the platform looks for them (JD-S6 R1, C2).
 *
 * This is the only place that stops preapprovals, in the three cases that need it:
 *
 * - **superseded**: the owner starts a new checkout while an earlier preapproval is paused or lost.
 *   Before the new one is asked for, every earlier one that is not provably cancelled is cancelled, with
 *   the usual write-ahead (a mark that commits first, a bounded call, the answer in another
 *   transaction). If one cannot be confirmed cancelled, no new preapproval is created.
 * - **cancelling**: the owner cancels (or the paid period ends). Every live preapproval the platform
 *   can find is cancelled, the ones it holds, the ones it made earlier and the ones that carry one of
 *   its references at the provider, parked or not.
 * - **stray**: the reconcile finds a live preapproval under a reference of this subscription that the
 *   platform had given up on (a request that landed late). It is cancelled, and a charge it made is
 *   flagged as a surplus by the ledger.
 */

export type StopOutcome = 'cancelled' | 'unavailable' | 'in_progress' | 'attention';

export type StopReason = 'cancelling' | 'superseded' | 'stray';

/**
 * Stops ONE preapproval of the organization at the provider: the mark (committed first), the bounded
 * call with nothing held, and the answer. The provider is asked to cancel only what the platform
 * recorded or found by its own references; the attempt names the preapproval so that an unknown
 * outcome is settled by reading THAT one.
 */
export async function cancelPreapprovalById(
  deps: SubscriptionDeps,
  tenantId: string,
  preapprovalId: string,
  why: StopReason,
): Promise<StopOutcome> {
  const gateway = gatewayOf(deps);
  if (!gateway) return 'unavailable';
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, work);

  const planned = await as(async (tx) => {
    const row = await lockSubscription(tx);
    if (!row) return 'unavailable' as const;
    if (why === 'stray') {
      // The preapproval was adopted while the reconcile decided: it is the one that charges.
      if (row.providerPreapprovalId === preapprovalId) return 'spared' as const;
      // Parked for a person: what the provider holds is theirs to look at, not ours to remove.
      if (blocksProvider(row)) return 'attention' as const;
    }
    const open = await openAttempts(tx, row.id);
    if (open.some((attempt) => attempt.kind === 'cancel')) return 'in_progress' as const;
    const number = await nextAttemptNumber(tx, row.id, 'cancel');
    const attempt = await markAttempt(tx, {
      subscriptionId: row.id,
      kind: 'cancel',
      externalReference: `cancel:${row.id}:${String(number)}`,
      resourceId: preapprovalId,
      clock: deps.clock,
      settleWindowMs: gateway.settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
    });
    return { attemptId: attempt.id, key: attempt.idempotencyKey };
  });
  if (planned === 'spared') return 'cancelled';
  if (typeof planned === 'string') return planned;

  const sent = await callWithin(
    deps,
    (signal) => gateway.cancelPreapproval(preapprovalId, planned.key, signal),
    UNKNOWN_OUTCOME as CancelPreapprovalResult,
  );
  const timedOut = sent.timedOut || sent.threw;

  return as(async (tx): Promise<StopOutcome> => {
    const now = deps.clock();
    const row = await lockSubscription(tx);
    const attempt = await lockAttempt(tx, planned.attemptId);
    if (!row || !attempt) return 'in_progress';
    // The reconcile settled it while the provider was being waited for.
    if (attempt.state !== 'marked') {
      return attempt.state === 'confirmed' ? 'cancelled' : 'in_progress';
    }
    const answer = sent.value;
    if (answer.status === 'cancelled') {
      await resolveAttempt(tx, attempt, { state: 'confirmed', resourceId: preapprovalId, now });
      const cancelledForGood = row.status === 'cancelling' || row.status === 'cancelled';
      if (preapprovalId === row.providerPreapprovalId && cancelledForGood) {
        await tx
          .update(subscription)
          .set({ authorizationState: 'none', version: row.version + 1 })
          .where(eq(subscription.id, row.id));
      }
      if (why !== 'cancelling') {
        await audit(tx, {
          action: 'subscription.preapproval_cancelled',
          outcome: 'allow',
          actor: SYSTEM_ACTOR,
          resourceType: 'subscription',
          resourceId: row.id,
          metadata: { reason: why, providerPreapprovalId: preapprovalId },
        });
      }
      return 'cancelled';
    }
    if (answer.status === 'rejected') {
      await resolveAttempt(tx, attempt, { state: 'rejected', now, message: answer.message });
      if (why === 'cancelling') return 'unavailable';
      // The provider refuses to stop a preapproval the platform must not leave alive: a person decides.
      await parkSubscription(tx, row, 'unexpected_state', now);
      return 'attention';
    }
    if (!answer.outcomeUnknown && !timedOut) {
      await resolveAttempt(tx, attempt, { state: 'released', now, message: answer.message });
    } else {
      await noteUnknownOutcome(tx, attempt.id, answer.message, {
        now,
        settleWindowMs: settleWindowOf(deps),
      });
    }
    return 'unavailable';
  });
}

/** A read of the provider: the answer, or `'unavailable'` when it said "try later" or did not answer. */
async function ask<T>(
  deps: SubscriptionDeps,
  call: (signal: AbortSignal) => Promise<T>,
  usable: (value: T) => boolean,
): Promise<Read<T>> {
  const { value } = await callWithin(deps, call, undefined as T | undefined);
  return value !== undefined && usable(value) ? value : 'unavailable';
}

/**
 * The live preapprovals that carry one of the references the platform used for this subscription, and
 * are not the one it holds (nor `spare`). A reference whose request is still in flight is left alone:
 * the settlement of that attempt decides what it is. `complete` is false when the provider could not
 * be asked about some reference, which means "nothing found" proves nothing.
 */
export async function findLivePreapprovals(
  deps: SubscriptionDeps,
  gateway: PaymentsGateway,
  references: readonly string[],
  spare: ReadonlySet<string>,
): Promise<{ live: PreapprovalDescription[]; complete: boolean }> {
  const live = new Map<string, PreapprovalDescription>();
  let complete = true;
  for (const reference of new Set(references)) {
    const answer = await ask(
      deps,
      (signal) => gateway.findPreapprovalsByReference(reference, signal),
      (reply) => reply.status === 'ok',
    );
    if (answer === 'unavailable' || answer.status !== 'ok') {
      complete = false;
      continue;
    }
    for (const found of answer.preapprovals) {
      if (found.status !== 'cancelled' && !spare.has(found.preapprovalId)) {
        live.set(found.preapprovalId, found);
      }
    }
  }
  return { live: [...live.values()], complete };
}

export type SweepOutcome =
  | { status: 'clear'; cancelled: number }
  | { status: 'unavailable' }
  | { status: 'in_progress' }
  | { status: 'attention' };

export interface SweepOptions {
  why: Exclude<StopReason, 'stray'>;
  /** Look also under the references of requests that are parked for a person. */
  includeParked: boolean;
  /** A request to create a preapproval that is in flight may still land: do not call it clear. */
  waitForCreation: boolean;
  /**
   * Settles a cancellation whose outcome was not known and whose window has passed (the reconcile
   * reads that preapproval and decides). Without it such a cancellation is waited for.
   */
  settle?: () => Promise<void>;
}

/**
 * Stops every preapproval of the subscription the platform can find alive, and says whether none is
 * left. "Alive" is read from the provider: the one the subscription holds and the ones it asked for
 * before are read by id, and the references of every request are searched, so a preapproval that
 * landed after the caller gave up is found too. A provider that cannot be asked proves nothing, and
 * the answer is then never "clear".
 */
export async function cancelLivePreapprovals(
  deps: SubscriptionDeps,
  tenantId: string,
  options: SweepOptions,
): Promise<SweepOutcome> {
  const gateway = gatewayOf(deps);
  if (!gateway) return { status: 'unavailable' };

  const read = () =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
      const row = await findSubscription(tx);
      if (!row) return null;
      const attempts = (await tx
        .select()
        .from(subscriptionAttempt)
        .where(eq(subscriptionAttempt.subscriptionId, row.id))) as SubscriptionAttemptRow[];
      return { current: row.providerPreapprovalId, attempts };
    });
  let known = await read();
  if (!known) return { status: 'clear', cancelled: 0 };

  // A cancellation whose outcome is not known is settled before another write is made: waited for
  // while its window is open, read and decided once it is over.
  const pending = (attempts: readonly SubscriptionAttemptRow[]) =>
    attempts.filter((attempt) => attempt.kind === 'cancel' && attempt.state === 'marked');
  if (pending(known.attempts).length > 0) {
    const open = pending(known.attempts).some(
      (a) => deps.clock().getTime() < a.settleUntil.getTime(),
    );
    if (open || !options.settle) return { status: 'in_progress' };
    await options.settle();
    known = await read();
    if (!known) return { status: 'clear', cancelled: 0 };
    if (pending(known.attempts).length > 0) return { status: 'in_progress' };
  }

  const creations = known.attempts.filter((attempt) => attempt.kind === 'preapproval');
  if (options.waitForCreation && creations.some((attempt) => attempt.state === 'marked')) {
    return { status: 'in_progress' };
  }

  const ids = new Set<string>();
  if (known.current !== null) ids.add(known.current);
  for (const attempt of creations) {
    if (attempt.state === 'confirmed' && attempt.resourceId !== null) ids.add(attempt.resourceId);
  }
  const references = creations
    .filter((attempt) => attempt.state !== 'marked')
    .filter((attempt) => options.includeParked || attempt.state !== 'parked')
    .map((attempt) => attempt.externalReference);

  const searched = await findLivePreapprovals(deps, gateway, references, new Set());
  let complete = searched.complete;
  const live = new Set(searched.live.map((found) => found.preapprovalId));
  for (const id of ids) {
    if (live.has(id)) continue;
    const answer = await ask(
      deps,
      (signal) => gateway.getPreapproval(id, signal),
      (reply) => reply.status !== 'retryable',
    );
    if (answer === 'unavailable') {
      complete = false;
    } else if (answer.status === 'found' && answer.preapproval.status !== 'cancelled') {
      live.add(id);
    }
  }

  let cancelled = 0;
  for (const id of live) {
    const outcome = await cancelPreapprovalById(deps, tenantId, id, options.why);
    if (outcome !== 'cancelled') return { status: outcome };
    cancelled += 1;
  }
  return complete ? { status: 'clear', cancelled } : { status: 'unavailable' };
}

/** Stops the strays a reconcile found, one at a time; the first that cannot be stopped ends the pass. */
export async function cancelStrays(
  deps: SubscriptionDeps,
  tenantId: string,
  strays: readonly PreapprovalDescription[],
): Promise<void> {
  for (const stray of strays) {
    const outcome = await cancelPreapprovalById(deps, tenantId, stray.preapprovalId, 'stray');
    if (outcome !== 'cancelled') return;
  }
}

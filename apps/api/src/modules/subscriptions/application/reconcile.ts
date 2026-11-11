import type { SubscriptionStatus } from '@consultorio/contracts';
import { and, eq, gt, sql } from 'drizzle-orm';

import {
  subscription,
  subscriptionAttempt,
  subscriptionPayment,
  type PlanRow,
  type SubscriptionAttemptRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import {
  decideAmountChangeAttempt,
  decideCancelAttempt,
  decideLinkAttempt,
  decidePreapprovalAttempt,
  decideRefundAttempt,
  type Timing,
  type Verdict,
} from '../domain/attempt-decisions.js';

import { clearAttention, openAttempts, parkSubscription, resolveAttempt } from './attempts.js';
import { cancelAtProvider } from './cancel-at-provider.js';
import { allocatePayments, collectStatements, reauthorizationSettled } from './collection.js';
import { DAY_MS, SYSTEM_ACTOR } from './common.js';
import { applyLedger } from './ledger-store.js';
import { claimNotice, sendPendingNotices } from './notices.js';
import type {
  PaymentDescription,
  PaymentLinkDescription,
  PaymentsGateway,
  PreapprovalDescription,
} from './ports.js';
import { cancelStrays, findLivePreapprovals } from './preapprovals.js';
import { callWithin, gatewayOf, type Read, type SubscriptionDeps } from './provider.js';
import { automaticReasonOf, recordRefund, refundDuplicates } from './refunds.js';
import { findPlan, findSubscription, lockSubscription, readTenantBilling } from './store.js';
import { applyEvent } from './transitions.js';

/**
 * Asks the provider where everything stands and writes what it says (`subscription.reconcile`). It is
 * the only way the state of a subscription follows the provider, and it is built for a provider that
 * is not idempotent, whose requests can land after the caller gave up, and which may be down:
 *
 * - **The provider is the authority, and the webhook is not.** A notice only queues this; the state is
 *   whatever the provider answers when it is asked now. A forged, repeated, old or out-of-order notice
 *   therefore cannot set a state.
 * - **Short transactions, none across a call.** The first reads what to ask (no lock), the questions are
 *   asked with nothing held and bounded by a timeout, and the last locks the subscription to write the
 *   answers. The job transaction of the framework stays idle meanwhile: the family is in
 *   `CONNECTION_HOLDING_JOBS`.
 * - **An unknown outcome is settled by looking, never by believing.** A write the platform sent and
 *   does not know the result of is searched by its reference. Adopt only when every identifying field
 *   equals what was asked; release it only after the settle window; park it when more than one
 *   resource could be ours (`domain/attempt-decisions.ts`).
 * - **An outage changes nothing.** What could not be read is not written, and a state never moves
 *   because a confirmation is missing.
 */

export type ReconcileOutcome =
  /** Nothing to reconcile: no preapproval and no open write. */
  | 'nothing'
  /** The provider could not be asked for something that matters; nothing that depends on it changed. */
  | 'unavailable'
  | 'done';

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  /** The state before and after, when it changed. */
  from: SubscriptionStatus | null;
  to: SubscriptionStatus | null;
}

const NOTHING: ReconcileResult = { outcome: 'nothing', from: null, to: null };

interface Snapshot {
  sub: SubscriptionRow;
  plan: PlanRow;
  attempts: SubscriptionAttemptRow[];
  /** One-off links already confirmed, whose payments are still looked for. */
  links: SubscriptionAttemptRow[];
  /** Every request for a preapproval the platform ever made, however it ended. */
  creations: SubscriptionAttemptRow[];
}

/** What the provider answered. A field is absent when there was nothing to ask. */
interface Facts {
  preapproval: Read<PreapprovalDescription | 'unknown'> | undefined;
  payments: Read<PaymentDescription[]> | undefined;
  /** What each open write was searched for. */
  searches: Map<string, Read<unknown>>;
  /** Preapprovals alive at the provider under a reference the platform had given up on. */
  strays: PreapprovalDescription[];
  /** The preapprovals of this subscription that are not the one it holds, whose payments are not ours to credit. */
  earlier: Set<string>;
}

const LINK_WATCH_DAYS = 60;

/**
 * How long after a request for a preapproval the platform keeps looking for one that landed late. A
 * request that was given up on can land only within minutes of the settle window, so a fortnight is
 * far more than needed, and an abandoned checkout is not asked about for ever.
 */
const STRAY_WATCH_DAYS = 14;

/** The requests for a preapproval recent enough to be looked for under their reference. */
function recentCreations(snapshot: Snapshot, now: Date): SubscriptionAttemptRow[] {
  const since = now.getTime() - STRAY_WATCH_DAYS * DAY_MS;
  return snapshot.creations.filter((attempt) => attempt.markedAt.getTime() > since);
}

async function readSnapshot(tx: Tx, now: Date): Promise<Snapshot | null> {
  const billing = await readTenantBilling(tx);
  if (billing.exempt) return null;
  const sub = await findSubscription(tx);
  if (!sub) return null;
  const plan = await findPlan(tx, sub.planId);
  const attempts = await openAttempts(tx, sub.id);
  const links = await tx
    .select()
    .from(subscriptionAttempt)
    .where(
      and(
        eq(subscriptionAttempt.subscriptionId, sub.id),
        eq(subscriptionAttempt.kind, 'payment_link'),
        eq(subscriptionAttempt.state, 'confirmed'),
        gt(subscriptionAttempt.markedAt, new Date(now.getTime() - LINK_WATCH_DAYS * DAY_MS)),
      ),
    );
  const creations = await tx
    .select()
    .from(subscriptionAttempt)
    .where(
      and(
        eq(subscriptionAttempt.subscriptionId, sub.id),
        eq(subscriptionAttempt.kind, 'preapproval'),
      ),
    );
  return { sub, plan, attempts, links, creations };
}

/** A read: the answer, or `'unavailable'` when the provider said "try later" or did not answer. */
async function ask<T>(
  deps: SubscriptionDeps,
  call: (signal: AbortSignal) => Promise<T>,
  usable: (value: T) => boolean,
): Promise<Read<T>> {
  const { value } = await callWithin(deps, call, undefined as T | undefined);
  return value !== undefined && usable(value) ? value : 'unavailable';
}

async function readFacts(
  deps: SubscriptionDeps,
  gateway: PaymentsGateway,
  snapshot: Snapshot,
): Promise<Facts> {
  const { sub } = snapshot;
  const facts: Facts = {
    preapproval: undefined,
    payments: undefined,
    searches: new Map(),
    strays: [],
    earlier: new Set(),
  };

  if (sub.providerPreapprovalId !== null) {
    const id = sub.providerPreapprovalId;
    facts.preapproval = await ask(
      deps,
      (signal) => gateway.getPreapproval(id, signal),
      (answer) => answer.status !== 'retryable',
    ).then((answer) => {
      if (answer === 'unavailable') return answer;
      return answer.status === 'found' ? answer.preapproval : 'unknown';
    });
  }

  // A preapproval the platform asked for and gave up on, or replaced, may be alive: a request that
  // landed after the caller stopped waiting, or one that was paused and resumed. It charges too, so it
  // is looked for under every reference this subscription used, and its payments are looked at.
  const spare = new Set(sub.providerPreapprovalId === null ? [] : [sub.providerPreapprovalId]);
  const settledReferences = recentCreations(snapshot, deps.clock())
    .filter((attempt) => attempt.state !== 'marked' && attempt.state !== 'parked')
    .map((attempt) => attempt.externalReference);
  if (settledReferences.length > 0) {
    facts.strays = (await findLivePreapprovals(deps, gateway, settledReferences, spare)).live;
  }
  for (const attempt of snapshot.creations) {
    if (
      attempt.state === 'confirmed' &&
      attempt.resourceId !== null &&
      !spare.has(attempt.resourceId)
    ) {
      facts.earlier.add(attempt.resourceId);
    }
  }
  for (const stray of facts.strays) facts.earlier.add(stray.preapprovalId);

  const found: PaymentDescription[] = [];
  const reading = { complete: true };
  const collect = async (query: { preapprovalId: string } | { externalReference: string }) => {
    const answer = await ask(
      deps,
      (signal) => gateway.findPayments(query, signal),
      (reply) => reply.status === 'ok',
    );
    if (answer === 'unavailable' || answer.status !== 'ok') reading.complete = false;
    else found.push(...answer.payments);
  };
  if (sub.providerPreapprovalId !== null) {
    await collect({ preapprovalId: sub.providerPreapprovalId });
  }
  for (const earlier of facts.earlier) await collect({ preapprovalId: earlier });
  for (const link of [
    ...snapshot.links,
    ...snapshot.attempts.filter((a) => a.kind === 'payment_link'),
  ]) {
    await collect({ externalReference: link.externalReference });
  }
  if (sub.providerPreapprovalId !== null || snapshot.links.length > 0 || facts.earlier.size > 0) {
    facts.payments = reading.complete ? dedupe(found) : 'unavailable';
  }

  for (const attempt of snapshot.attempts) {
    if (attempt.state !== 'marked') continue;
    if (attempt.kind === 'preapproval') {
      facts.searches.set(
        attempt.id,
        await ask(
          deps,
          (signal) => gateway.findPreapprovalsByReference(attempt.externalReference, signal),
          (reply) => reply.status === 'ok',
        ).then((reply) =>
          reply === 'unavailable' || reply.status !== 'ok' ? 'unavailable' : reply.preapprovals,
        ),
      );
    } else if (attempt.kind === 'payment_link') {
      facts.searches.set(
        attempt.id,
        await ask(
          deps,
          (signal) => gateway.findPaymentLinksByReference(attempt.externalReference, signal),
          (reply) => reply.status === 'ok',
        ).then((reply) =>
          reply === 'unavailable' || reply.status !== 'ok' ? 'unavailable' : reply.links,
        ),
      );
    } else if (attempt.kind === 'refund' && attempt.paymentId !== null) {
      const paymentId = attempt.paymentId;
      facts.searches.set(
        attempt.id,
        await ask(
          deps,
          (signal) => gateway.getPayment(paymentId, signal),
          (reply) => reply.status !== 'retryable',
        ).then((reply) =>
          reply === 'unavailable' ? reply : reply.status === 'found' ? reply.payment : 'unknown',
        ),
      );
    } else if (attempt.kind === 'cancel' && attempt.resourceId !== null) {
      // A cancellation names the preapproval it was about: that one is read, not the current one.
      const target = attempt.resourceId;
      facts.searches.set(
        attempt.id,
        await ask(
          deps,
          (signal) => gateway.getPreapproval(target, signal),
          (reply) => reply.status !== 'retryable',
        ).then((reply) =>
          reply === 'unavailable'
            ? reply
            : reply.status === 'found'
              ? reply.preapproval
              : 'unknown',
        ),
      );
    }
    // The change of amount and a cancellation of the current preapproval read it above.
  }
  return facts;
}

function dedupe(payments: readonly PaymentDescription[]): PaymentDescription[] {
  return [...new Map(payments.map((payment) => [payment.paymentId, payment])).values()];
}

const timingOf = (attempt: SubscriptionAttemptRow, now: Date): Timing => ({
  now,
  settleUntil: attempt.settleUntil,
});

/**
 * What an attempt that is still open is decided to be, from what the provider says. `searchedAt` is
 * the instant the questions began, NOT the instant the answers are written: the provider answered as
 * of the first one, so a window that closed in between does not make "nothing there" safe, because a
 * request may have landed after the search read the provider (JD-S6 R1, S6-13).
 */
function verdictOf(
  attempt: SubscriptionAttemptRow,
  facts: Facts,
  sub: SubscriptionRow,
  searchedAt: Date,
): Verdict<unknown> | null {
  const timing = timingOf(attempt, searchedAt);
  const asked = {
    externalReference: attempt.externalReference,
    payerEmail: attempt.payerEmail ?? '',
    amountCents: attempt.amountCents,
  };
  const current = facts.preapproval;
  switch (attempt.kind) {
    case 'preapproval': {
      const found = facts.searches.get(attempt.id) as
        readonly PreapprovalDescription[] | 'unavailable' | undefined;
      return found === undefined ? null : decidePreapprovalAttempt({ asked, found, timing });
    }
    case 'payment_link': {
      const found = facts.searches.get(attempt.id) as
        readonly PaymentLinkDescription[] | 'unavailable' | undefined;
      return found === undefined ? null : decideLinkAttempt({ asked, found, timing });
    }
    case 'amount_change':
      if (sub.providerPreapprovalId === null || current === undefined) return null;
      return decideAmountChangeAttempt({
        previousCents: attempt.previousAmountCents ?? 0,
        askedCents: attempt.amountCents,
        found: current,
        timing,
      });
    case 'cancel': {
      if (attempt.resourceId !== null) {
        // The cancellation names the preapproval it was about. Nothing under that id at the provider
        // is nothing alive, which is what a cancellation is for.
        const target = facts.searches.get(attempt.id) as
          PreapprovalDescription | 'unavailable' | 'unknown' | undefined;
        if (target === undefined) return null;
        return decideCancelAttempt({
          found: target === 'unknown' ? { status: 'cancelled' } : target,
          timing,
        });
      }
      if (sub.providerPreapprovalId === null || current === undefined) return null;
      return decideCancelAttempt({ found: current, timing });
    }
    case 'refund': {
      const found = facts.searches.get(attempt.id) as
        PaymentDescription | 'unavailable' | 'unknown' | undefined;
      return found === undefined
        ? null
        : decideRefundAttempt({
            refundIdsBefore: attempt.refundIdsBefore ?? [],
            askedCents: attempt.amountCents,
            found,
            timing,
          });
    }
    default:
      return null;
  }
}

/** Closes the open writes the provider's answers decide, in the transaction that holds the lock. */
async function settleAttempts(
  tx: Tx,
  sub: SubscriptionRow,
  attempts: readonly SubscriptionAttemptRow[],
  facts: Facts,
  now: Date,
  searchedAt: Date,
): Promise<SubscriptionRow> {
  let row = sub;
  for (const open of attempts) {
    if (open.state !== 'marked') continue;
    // The attempt may have been settled by the request that made it, between the snapshot and now.
    const [fresh] = await tx
      .select()
      .from(subscriptionAttempt)
      .where(eq(subscriptionAttempt.id, open.id));
    if (fresh?.state !== 'marked') continue;
    const verdict = verdictOf(fresh, facts, row, searchedAt);
    if (verdict === null || verdict.kind === 'wait') continue;

    if (verdict.kind === 'release') {
      await resolveAttempt(tx, fresh, { state: 'released', now });
      continue;
    }
    if (verdict.kind === 'park') {
      await resolveAttempt(tx, fresh, { state: 'parked', now, message: verdict.reason });
      await parkSubscription(tx, row, verdict.reason, now);
      row = (await findSubscription(tx)) ?? row;
      continue;
    }

    // adopt
    if (fresh.kind === 'preapproval') {
      const found = verdict.resource as PreapprovalDescription;
      const holdsOther =
        row.providerPreapprovalId !== null &&
        row.providerPreapprovalId !== found.preapprovalId &&
        (row.authorizationState === 'authorized' || row.authorizationState === 'pending');
      if (holdsOther) {
        await resolveAttempt(tx, fresh, { state: 'parked', now, message: 'ambiguous_preapproval' });
        await parkSubscription(tx, row, 'ambiguous_preapproval', now);
        row = (await findSubscription(tx)) ?? row;
        continue;
      }
      await resolveAttempt(tx, fresh, {
        state: 'confirmed',
        resourceId: found.preapprovalId,
        resourceUrl: found.checkoutUrl ?? null,
        now,
      });
      const [linked] = await tx
        .update(subscription)
        .set({
          providerPreapprovalId: found.preapprovalId,
          externalReference: fresh.externalReference,
          authorizationState: row.authorizationState === 'authorized' ? 'authorized' : 'pending',
          authorizedAmountCents: found.amountCents,
          version: row.version + 1,
        })
        .where(eq(subscription.id, row.id))
        .returning();
      if (linked) row = linked;
    } else if (fresh.kind === 'payment_link') {
      const found = verdict.resource as PaymentLinkDescription;
      await resolveAttempt(tx, fresh, {
        state: 'confirmed',
        resourceId: found.linkId,
        resourceUrl: found.url,
        now,
      });
      // A link made for a statement: the owner is told what it is for, as when the answer came back.
      if (fresh.statementId !== null) {
        await claimNotice(tx, row.id, 'amount_change_refused', fresh.statementId);
      }
    } else if (fresh.kind === 'refund') {
      const found = verdict.resource as {
        refundId: string;
        amountCents: number;
        createdAt: string;
      };
      await resolveAttempt(tx, fresh, { state: 'confirmed', resourceId: found.refundId, now });
      // The refund landed: it becomes the entry it would have been, and the payment shows it.
      const payment = facts.searches.get(fresh.id) as PaymentDescription | undefined;
      const [recorded] = await tx
        .select()
        .from(subscriptionPayment)
        .where(
          and(
            eq(subscriptionPayment.subscriptionId, row.id),
            eq(subscriptionPayment.providerPaymentId, fresh.paymentId ?? ''),
          ),
        );
      if (recorded && payment) {
        await recordRefund(
          tx,
          SYSTEM_ACTOR,
          row.id,
          recorded,
          payment,
          found,
          now,
          automaticReasonOf(fresh.externalReference),
        );
      }
    } else {
      await resolveAttempt(tx, fresh, { state: 'confirmed', now });
      if (fresh.kind === 'amount_change') {
        const [moved] = await tx
          .update(subscription)
          .set({ authorizedAmountCents: fresh.amountCents, version: row.version + 1 })
          .where(eq(subscription.id, row.id))
          .returning();
        if (moved) row = moved;
      }
    }
  }
  return row;
}

/**
 * Brings the subscription of an organization to what the provider says. Safe to run at any time and
 * any number of times; two runs at once end with the same result (the second finds nothing to write).
 */
export async function reconcileSubscription(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<ReconcileResult> {
  const gateway = gatewayOf(deps);
  if (!gateway) return NOTHING;
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, work);

  const snapshot = await as((tx) => readSnapshot(tx, deps.clock()));
  if (!snapshot) return NOTHING;
  const { sub, attempts, links } = snapshot;
  const watching = recentCreations(snapshot, deps.clock()).length > 0;
  if (
    sub.providerPreapprovalId === null &&
    attempts.length === 0 &&
    links.length === 0 &&
    !watching
  ) {
    return NOTHING;
  }

  // The questions to the provider begin now: this instant, and no later one, is what "the window has
  // passed" is judged against when the answers are written.
  const searchedAt = deps.clock();
  const facts = await readFacts(deps, gateway, snapshot);
  const coreUnavailable = facts.preapproval === 'unavailable' || facts.payments === 'unavailable';

  const result = await as(async (tx): Promise<ReconcileResult> => {
    const locked = await lockSubscription(tx);
    if (!locked) return NOTHING;
    const now = deps.clock();
    const plan = await findPlan(tx, locked.planId);
    const fromStatus = locked.status as SubscriptionStatus;
    let row = await settleAttempts(tx, locked, snapshot.attempts, facts, now, searchedAt);

    // What the provider says about the preapproval this subscription charges through.
    const preapproval = facts.preapproval;
    if (preapproval !== undefined && preapproval !== 'unavailable') {
      row = await applyPreapproval(tx, deps, row, plan, preapproval, now);
    }

    // What the provider says about the payments.
    if (facts.payments !== undefined && facts.payments !== 'unavailable') {
      row = await applyPayments(tx, deps, row, plan, facts.payments, facts.earlier, now);
    }

    if (!coreUnavailable) {
      await tx
        .update(subscription)
        .set({ lastReconciledAt: now })
        .where(eq(subscription.id, row.id));
    }
    // A parked subscription whose cause has settled by itself goes again (JD-S6 R1, C1).
    if (row.attentionReason === 'reauthorization_needed') {
      row = await clearSettledReauthorization(tx, row);
    }
    // The notices of the provider are a nudge to ask, and one that is older than a month is of no use.
    await tx.execute(
      sql`select app.subscription_event_purge(${new Date(now.getTime() - 30 * DAY_MS).toISOString()}::timestamptz)`,
    );
    const toStatus = row.status as SubscriptionStatus;
    return {
      outcome: coreUnavailable ? 'unavailable' : 'done',
      from: fromStatus === toStatus ? null : fromStatus,
      to: fromStatus === toStatus ? null : toStatus,
    };
  });
  // A published statement whose window passed moves the amount the provider charges (or asks for the
  // difference): its own short transactions, with the mark of every write committed before its call.
  if (result.outcome === 'done') await collectStatements(deps, tenantId).catch(() => 'nothing');
  // A preapproval that charges next to the one this subscription holds is stopped (after the commit,
  // with its own mark and call), and a duplicate of an overdue payment is given back.
  if (result.outcome === 'done') {
    await cancelStrays(deps, tenantId, facts.strays).catch(() => undefined);
    await refundDuplicates(deps, tenantId).catch(() => undefined);
  }
  // The owner is told what the changes above owe them: after the commit, outside any transaction.
  await sendPendingNotices(deps, tenantId).catch(() => 0);
  // A cancelling subscription whose authorization is still in force is told to the provider again.
  if (result.outcome === 'done') await cancelAtProvider(deps, tenantId).catch(() => 'unavailable');
  return result;
}

/** Clears the parked state of a subscription that waited for an authorization nobody needs any more. */
async function clearSettledReauthorization(tx: Tx, row: SubscriptionRow): Promise<SubscriptionRow> {
  if (!(await reauthorizationSettled(tx, row))) return row;
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
  return (await findSubscription(tx)) ?? row;
}

async function applyPreapproval(
  tx: Tx,
  deps: SubscriptionDeps,
  start: SubscriptionRow,
  plan: PlanRow,
  preapproval: PreapprovalDescription | 'unknown',
  now: Date,
): Promise<SubscriptionRow> {
  let row = start;
  const wasAuthorized = row.authorizationState === 'authorized';
  const cancelledByUs = row.cancelRequestedAt !== null || row.status === 'cancelled';

  let authorization: SubscriptionRow['authorizationState'];
  let label = row.paymentMethodLabel;
  let nextChargeAt = row.nextChargeAt;
  let authorizedAmountCents = row.authorizedAmountCents;
  if (preapproval === 'unknown') {
    // The provider holds nothing under the id the platform recorded: the authorization is not in force.
    authorization = 'lost';
  } else if (preapproval.status === 'authorized') {
    authorization = 'authorized';
    label = preapproval.paymentMethodLabel ?? label;
    nextChargeAt =
      preapproval.nextChargeAt === undefined ? nextChargeAt : new Date(preapproval.nextChargeAt);
    authorizedAmountCents = preapproval.amountCents;
  } else if (preapproval.status === 'pending') {
    authorization = row.authorizationState === 'authorized' ? 'authorized' : 'pending';
  } else if (preapproval.status === 'cancelled') {
    authorization = cancelledByUs ? 'none' : 'lost';
  } else {
    authorization = 'lost';
  }

  // Only a difference is written: asking again about something that did not change writes nothing.
  const differs =
    authorization !== row.authorizationState ||
    label !== row.paymentMethodLabel ||
    nextChargeAt?.getTime() !== row.nextChargeAt?.getTime() ||
    authorizedAmountCents !== row.authorizedAmountCents;
  if (differs) {
    const [updated] = await tx
      .update(subscription)
      .set({
        authorizationState: authorization,
        paymentMethodLabel: label,
        nextChargeAt,
        authorizedAmountCents,
        version: row.version + 1,
      })
      .where(eq(subscription.id, row.id))
      .returning();
    if (updated) row = updated;
  }
  if (authorization === 'authorized' && !wasAuthorized) {
    row = (
      await applyEvent({
        tx,
        row,
        plan,
        event: { type: 'authorization_confirmed' },
        now,
        tenantCancelled: deps.tenantCancelled,
      })
    ).row;
  }
  return row;
}

async function applyPayments(
  tx: Tx,
  deps: SubscriptionDeps,
  start: SubscriptionRow,
  plan: PlanRow,
  payments: readonly PaymentDescription[],
  earlier: ReadonlySet<string>,
  now: Date,
): Promise<SubscriptionRow> {
  const ledger = await applyLedger(tx, start, payments, earlier);
  let row = ledger.row;
  // A payment with no amount cannot be recorded and is skipped, so it cannot wedge the pass; the log
  // says so (never who paid or how much).
  if (ledger.plan.effects.skipped.length > 0) {
    deps.log?.error(
      { skipped: ledger.plan.effects.skipped.length },
      'payments with no amount were skipped by the reconcile',
    );
  }
  // What the provider collected is booked against the statements it was owed for.
  await allocatePayments(tx, row.id, now);
  const { effects } = ledger.plan;

  if (effects.approvedCounted) {
    row = (
      await applyEvent({
        tx,
        row,
        plan,
        event: { type: 'payment_approved' },
        now,
        tenantCancelled: deps.tenantCancelled,
      })
    ).row;
  }
  // A failure counts only when nothing newer was paid: a retry that succeeded makes the failure history.
  const failedAt = effects.rejectedChargeAt;
  const paidAfter = effects.approvedCountedAt;
  if (failedAt !== null && (paidAfter === null || failedAt.getTime() > paidAfter.getTime())) {
    row = (
      await applyEvent({
        tx,
        row,
        plan,
        event: { type: 'payment_rejected', at: failedAt },
        now,
        tenantCancelled: deps.tenantCancelled,
      })
    ).row;
  }
  return row;
}

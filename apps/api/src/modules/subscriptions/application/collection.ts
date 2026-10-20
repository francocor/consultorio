import { and, asc, eq, isNull, lt } from 'drizzle-orm';

import {
  statement,
  subscription,
  subscriptionAttempt,
  subscriptionPayment,
  type StatementRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import { SYSTEM_USER_ID, type Tx } from '../../../platform/db/tenant-context.js';
import { linkMatches } from '../domain/attempt-decisions.js';
import { mayCollect } from '../domain/statement.js';

import {
  lockAttempt,
  markAttempt,
  nextAttemptNumber,
  noteUnknownOutcome,
  openAttempts,
  parkSubscription,
  resolveAttempt,
} from './attempts.js';
import { DAY_MS } from './common.js';
import { claimNotice, ownerEmails } from './notices.js';
import type { CreatePaymentLinkResult, UpdatePreapprovalAmountResult } from './ports.js';
import { UNKNOWN_OUTCOME, callWithin, gatewayOf, type SubscriptionDeps } from './provider.js';
import { AMOUNT_CHANGE_REFUSED, REAUTHORIZATION_REQUIRED } from './statements.js';
import { CURRENT_TENANT, lockSubscription, readTenantBilling } from './store.js';

/**
 * How a published statement is collected (SUB-08, SUB-15; decision Q2). Two parts:
 *
 * 1. **What was collected is booked against a statement** (`allocatePayments`): a payment the provider
 *    approved after the owner's window counts toward the oldest statement that is not paid yet, and a
 *    payment link made for a statement counts toward that statement. What is booked never goes above the
 *    total of the statement, and a statement that is not published has no payment booked at all.
 * 2. **The amount the provider will charge is moved to what is owed** (`collectStatements`): once the
 *    window of the owner has passed (`STATEMENT_COLLECTION_DELAY_DAYS` after publication) and not
 *    before, the recurring amount is changed to what is left of the oldest statement. When the provider
 *    refuses to change a live authorization, the difference is asked as a payment link and the owner is
 *    told; when it asks for a new authorization, the owner is asked first and nothing is charged for the
 *    difference. The recurring amount is NEVER raised above what a published statement shows: the
 *    database repeats that (`app.subscription_attempt_statement_guard`).
 *
 * Every request to the provider follows the three steps of the module (a mark committed first, a
 * bounded call with nothing held, the answer in another transaction) and an outcome that is not known
 * is settled by the reconcile that reads the provider, never by a guess.
 */

// Booking what was collected -------------------------------------------------------------------------

const STATEMENT_REFERENCE = /^stmt:([0-9a-f-]{36}):\d+$/;

/** The statement a payment link was made for, from the reference the server derived for it. */
export function statementOfReference(reference: string): string | null {
  return STATEMENT_REFERENCE.exec(reference)?.[1] ?? null;
}

/**
 * Books the approved payments that are not booked yet. A charge of the recurring authorization counts
 * toward the oldest statement that is open and whose window had passed when the payment was made; a
 * charge before any window (the first one, made at the amount shown at checkout) counts toward no
 * statement. Running it again over the same payments changes nothing.
 */
export async function allocatePayments(tx: Tx, subscriptionId: string, now: Date): Promise<void> {
  const payments = await tx
    .select()
    .from(subscriptionPayment)
    .where(
      and(
        eq(subscriptionPayment.subscriptionId, subscriptionId),
        eq(subscriptionPayment.status, 'approved'),
        isNull(subscriptionPayment.statementId),
      ),
    )
    .orderBy(asc(subscriptionPayment.providerCreatedAt), asc(subscriptionPayment.id));
  const candidates = payments.filter(
    (payment) =>
      payment.purpose === 'statement' ||
      (payment.purpose === 'charge' && payment.credited && !payment.surplus),
  );
  if (candidates.length === 0) return;

  const statements = new Map<string, StatementRow>(
    (
      await tx
        .select()
        .from(statement)
        .where(eq(statement.subscriptionId, subscriptionId))
        .orderBy(asc(statement.period))
    ).map((row) => [row.id, row]),
  );

  for (const payment of candidates) {
    const named = payment.purpose === 'statement' ? statementOfReference(payment.reference) : null;
    const target =
      named !== null
        ? statements.get(named)
        : [...statements.values()].find(
            (row) =>
              row.collectedCents < row.totalCents &&
              row.collectAfter.getTime() <= payment.providerCreatedAt.getTime(),
          );
    if (!target) continue;
    const left = target.totalCents - target.collectedCents;
    const booked = Math.min(payment.amountCents, left);
    if (booked <= 0) continue;
    const collected = target.collectedCents + booked;
    const [updated] = await tx
      .update(statement)
      .set({
        collectedCents: collected,
        ...(collected === target.totalCents ? { collectedAt: now } : {}),
      })
      .where(eq(statement.id, target.id))
      .returning();
    if (updated) statements.set(updated.id, updated);
    await tx
      .update(subscriptionPayment)
      .set({ statementId: target.id })
      .where(eq(subscriptionPayment.id, payment.id));
  }
}

// Moving the amount ----------------------------------------------------------------------------------

export type CollectionOutcome =
  | 'nothing'
  /** A write was sent (and answered, or its outcome is settled later). */
  | 'sent'
  /** The provider is not reachable or still has something in flight: nothing more is sent now. */
  | 'waiting'
  /** The owner was asked for something, or the subscription was parked for a person. */
  | 'asked';

type Planned =
  | { kind: 'done'; outcome: CollectionOutcome }
  | {
      kind: 'change';
      attemptId: string;
      key: string;
      statementId: string;
      request: { preapprovalId: string; amountCents: number; externalReference: string };
    }
  | {
      kind: 'link';
      attemptId: string;
      key: string;
      statementId: string;
      request: Parameters<NonNullable<ReturnType<typeof gatewayOf>>['createPaymentLink']>[0];
    };

const LINK_LIFETIME_DAYS = 7;
const MAX_PASSES = 3;

/**
 * Moves the recurring amount of the subscription to what is left of the oldest statement whose window
 * passed, or asks for the difference some other way. Does nothing when there is nothing to move.
 */
export async function collectStatements(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<CollectionOutcome> {
  const gateway = gatewayOf(deps);
  if (!gateway) return 'nothing';
  const as = <T>(work: (tx: Tx) => Promise<T>) =>
    deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, work);

  let last: CollectionOutcome = 'nothing';
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const step = await as((tx) => plan(tx, deps, gateway.settleWindowMs));
    if (step.kind === 'done') return step.outcome === 'nothing' ? last : step.outcome;

    if (step.kind === 'change') {
      const sent = await callWithin(
        deps,
        (signal) => gateway.updatePreapprovalAmount(step.request, step.key, signal),
        UNKNOWN_OUTCOME as UpdatePreapprovalAmountResult,
      );
      await as((tx) => answerChange(tx, deps, step, sent.value, sent.timedOut || sent.threw));
    } else {
      const sent = await callWithin(
        deps,
        (signal) => gateway.createPaymentLink(step.request, step.key, signal),
        UNKNOWN_OUTCOME as CreatePaymentLinkResult,
      );
      await as((tx) => answerLink(tx, deps, step, sent.value, sent.timedOut || sent.threw));
    }
    last = 'sent';
  }
  return last;
}

async function plan(tx: Tx, deps: SubscriptionDeps, settleWindowMs: number): Promise<Planned> {
  const nothing: Planned = { kind: 'done', outcome: 'nothing' };
  const billing = await readTenantBilling(tx);
  if (billing.exempt) return nothing;
  const sub = await lockSubscription(tx);
  if (!sub) return nothing;
  // Only a subscription that is being charged is moved: a trial has no statement, a cancelling or
  // ended one is not charged again, and a read-only one recovers by paying what is overdue.
  if (sub.status !== 'active' && sub.status !== 'past_due') return nothing;
  if (sub.attentionReason !== null) return nothing;
  if (sub.providerPreapprovalId === null || sub.externalReference === null) return nothing;
  if (sub.authorizationState !== 'authorized') return nothing;

  const now = deps.clock();
  const open = (await openAttempts(tx, sub.id)).filter(
    (attempt) => attempt.statementId !== null || attempt.kind === 'amount_change',
  );
  if (open.length > 0) return { kind: 'done', outcome: 'waiting' };

  const [oldest] = await tx
    .select()
    .from(statement)
    .where(
      and(eq(statement.subscriptionId, sub.id), lt(statement.collectedCents, statement.totalCents)),
    )
    .orderBy(asc(statement.period))
    .limit(1);
  if (!oldest) return nothing;
  const outstanding = oldest.totalCents - oldest.collectedCents;
  // Not before the owner had time to see it, and never more than is left of it.
  if (!mayCollect(oldest, now, outstanding).allowed) return nothing;
  const authorized = sub.authorizedAmountCents ?? 0;
  if (authorized === outstanding) return nothing;

  const attempts = await tx
    .select()
    .from(subscriptionAttempt)
    .where(
      and(
        eq(subscriptionAttempt.subscriptionId, sub.id),
        eq(subscriptionAttempt.statementId, oldest.id),
      ),
    )
    .orderBy(asc(subscriptionAttempt.markedAt));
  const changes = attempts.filter((attempt) => attempt.kind === 'amount_change');
  const lastChange = changes[changes.length - 1];

  if (lastChange?.state === 'confirmed' && lastChange.amountCents === outstanding) {
    // The provider says it changed it; the reconcile brings the amount in. Nothing more to send.
    return nothing;
  }
  if (lastChange?.state === 'rejected') {
    if (lastChange.message === REAUTHORIZATION_REQUIRED) return { kind: 'done', outcome: 'asked' };
    if (lastChange.message !== AMOUNT_CHANGE_REFUSED) return nothing;
    return planDifference(
      tx,
      deps,
      sub,
      oldest,
      outstanding - authorized,
      attempts,
      settleWindowMs,
    );
  }

  const reference = sub.externalReference;
  const attempt = await markAttempt(tx, {
    subscriptionId: sub.id,
    kind: 'amount_change',
    externalReference: reference,
    amountCents: outstanding,
    previousAmountCents: authorized,
    statementId: oldest.id,
    now,
    settleWindowMs: settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
  });
  return {
    kind: 'change',
    attemptId: attempt.id,
    key: attempt.idempotencyKey,
    statementId: oldest.id,
    request: {
      preapprovalId: sub.providerPreapprovalId,
      amountCents: outstanding,
      externalReference: reference,
    },
  };
}

/** The provider will not change the amount: the difference is asked by a link, or a person decides. */
async function planDifference(
  tx: Tx,
  deps: SubscriptionDeps,
  sub: SubscriptionRow,
  oldest: StatementRow,
  difference: number,
  attempts: readonly (typeof subscriptionAttempt.$inferSelect)[],
  settleWindowMs: number,
): Promise<Planned> {
  const now = deps.clock();
  if (difference <= 0) {
    // The recurring charge would take MORE than is owed and the provider will not lower it: it is not
    // charged blindly. A person looks at it, and the owner is asked to authorize the right amount.
    await parkSubscription(tx, sub, 'reauthorization_needed', now);
    await claimNotice(tx, sub.id, 'reauthorization_needed', oldest.id);
    return { kind: 'done', outcome: 'asked' };
  }

  const links = attempts.filter((attempt) => attempt.kind === 'payment_link');
  if (links.some((attempt) => attempt.state === 'marked' || attempt.state === 'parked')) {
    return { kind: 'done', outcome: 'waiting' };
  }
  const paid = new Set(
    (
      await tx
        .select({ reference: subscriptionPayment.reference })
        .from(subscriptionPayment)
        .where(
          and(
            eq(subscriptionPayment.subscriptionId, sub.id),
            eq(subscriptionPayment.status, 'approved'),
          ),
        )
    ).map((payment) => payment.reference),
  );
  const alive = links.find(
    (attempt) =>
      attempt.state === 'confirmed' &&
      attempt.resourceUrl !== null &&
      !paid.has(attempt.externalReference) &&
      now.getTime() < attempt.markedAt.getTime() + LINK_LIFETIME_DAYS * DAY_MS,
  );
  if (alive) return { kind: 'done', outcome: 'nothing' };

  const [owner] = await ownerEmails(tx);
  const [org] = await tx
    .select({ slug: tenant.slug })
    .from(tenant)
    .where(eq(tenant.id, CURRENT_TENANT));
  if (!owner || !org || !deps.origins) return { kind: 'done', outcome: 'nothing' };
  const number = await nextAttemptNumber(tx, sub.id, 'payment_link');
  const externalReference = `stmt:${oldest.id}:${String(number)}`;
  const attempt = await markAttempt(tx, {
    subscriptionId: sub.id,
    kind: 'payment_link',
    externalReference,
    amountCents: difference,
    payerEmail: owner,
    statementId: oldest.id,
    now,
    settleWindowMs: settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
  });
  return {
    kind: 'link',
    attemptId: attempt.id,
    key: attempt.idempotencyKey,
    statementId: oldest.id,
    request: {
      externalReference,
      payerEmail: owner,
      title: `Resumen ${oldest.period} - diferencia a pagar`,
      amountCents: difference,
      currency: 'ARS',
      backUrl: `${deps.origins(org.slug)}/subscription`,
      expiresAt: new Date(now.getTime() + LINK_LIFETIME_DAYS * DAY_MS).toISOString(),
    },
  };
}

async function answerChange(
  tx: Tx,
  deps: SubscriptionDeps,
  step: Extract<Planned, { kind: 'change' }>,
  answer: UpdatePreapprovalAmountResult,
  unreachable: boolean,
): Promise<void> {
  const now = deps.clock();
  const row = await lockSubscription(tx);
  const attempt = await lockAttempt(tx, step.attemptId);
  if (!row || !attempt || attempt.state !== 'marked') return;

  if (answer.status === 'updated') {
    if (answer.preapproval.amountCents !== step.request.amountCents) {
      await resolveAttempt(tx, attempt, { state: 'parked', now, message: 'unexpected_state' });
      await parkSubscription(tx, row, 'unexpected_state', now);
      return;
    }
    await resolveAttempt(tx, attempt, { state: 'confirmed', now });
    await tx
      .update(subscription)
      .set({ authorizedAmountCents: answer.preapproval.amountCents, version: row.version + 1 })
      .where(eq(subscription.id, row.id));
    return;
  }
  if (answer.status === 'amount_change_refused') {
    await resolveAttempt(tx, attempt, { state: 'rejected', now, message: AMOUNT_CHANGE_REFUSED });
    return;
  }
  if (answer.status === 'reauthorization_required') {
    await resolveAttempt(tx, attempt, {
      state: 'rejected',
      now,
      message: REAUTHORIZATION_REQUIRED,
      resourceUrl: answer.checkoutUrl,
    });
    await claimNotice(tx, row.id, 'reauthorization_needed', step.statementId);
    return;
  }
  if (answer.status === 'rejected') {
    await resolveAttempt(tx, attempt, { state: 'rejected', now, message: answer.message });
    return;
  }
  // The provider could not be asked, or did not answer: the outcome is settled by reading it.
  if (!answer.outcomeUnknown && !unreachable) {
    await resolveAttempt(tx, attempt, { state: 'released', now, message: answer.message });
  } else {
    await noteUnknownOutcome(tx, attempt.id, answer.message);
  }
}

async function answerLink(
  tx: Tx,
  deps: SubscriptionDeps,
  step: Extract<Planned, { kind: 'link' }>,
  answer: CreatePaymentLinkResult,
  unreachable: boolean,
): Promise<void> {
  const now = deps.clock();
  const row = await lockSubscription(tx);
  const attempt = await lockAttempt(tx, step.attemptId);
  if (!row || !attempt || attempt.state !== 'marked') return;

  if (answer.status === 'created') {
    if (
      !linkMatches(
        {
          externalReference: step.request.externalReference,
          payerEmail: step.request.payerEmail,
          amountCents: step.request.amountCents,
        },
        answer.link,
      )
    ) {
      await resolveAttempt(tx, attempt, { state: 'parked', now, message: 'identity_mismatch' });
      await parkSubscription(tx, row, 'identity_mismatch', now);
      return;
    }
    await resolveAttempt(tx, attempt, {
      state: 'confirmed',
      resourceId: answer.link.linkId,
      resourceUrl: answer.link.url,
      now,
    });
    // The owner is told that the recurring charge cannot be changed and what to pay for the difference.
    await claimNotice(tx, row.id, 'amount_change_refused', step.statementId);
    return;
  }
  if (answer.status === 'rejected') {
    await resolveAttempt(tx, attempt, { state: 'rejected', now, message: answer.message });
    return;
  }
  if (!answer.outcomeUnknown && !unreachable) {
    await resolveAttempt(tx, attempt, { state: 'released', now, message: answer.message });
  } else {
    await noteUnknownOutcome(tx, attempt.id, answer.message);
  }
}

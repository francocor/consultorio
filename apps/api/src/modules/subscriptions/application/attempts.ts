import { randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  subscription,
  subscriptionAttempt,
  type AttemptKind,
  type AttemptState,
  type AttentionReason,
  type SubscriptionAttemptRow,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { SYSTEM_ACTOR } from './common.js';
import { CURRENT_TENANT } from './store.js';

/**
 * The write-ahead log of the payments provider (`subscription_attempt`). Every write to the provider
 * is preceded by `markAttempt`, in a short transaction that COMMITS before the call, and followed by
 * `resolveAttempt` in another one. Nothing here talks to the provider.
 */

export interface MarkInput {
  subscriptionId: string;
  kind: AttemptKind;
  /** Derived by the server from the subscription (or the statement) and the attempt number. */
  externalReference: string;
  amountCents?: number;
  payerEmail?: string | null;
  previousAmountCents?: number | null;
  statementId?: string | null;
  paymentId?: string | null;
  refundIdsBefore?: string[] | null;
  /** The instant the request is about to be sent. */
  now: Date;
  /** How long a request that is given up on may still land (`PaymentsGateway.settleWindowMs`). */
  settleWindowMs: number;
}

/**
 * Writes the intent to send a request. The key is derived from the reference, so every attempt has a
 * key of its own and the provider (which may not honour keys) can never confuse two of them. The
 * unique index lets one write of a kind be open at a time: a second caller finds the first one's row.
 */
export async function markAttempt(tx: Tx, input: MarkInput): Promise<SubscriptionAttemptRow> {
  const [row] = await tx
    .insert(subscriptionAttempt)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      subscriptionId: input.subscriptionId,
      kind: input.kind,
      externalReference: input.externalReference,
      idempotencyKey: `${input.externalReference}:${input.kind}:${randomUUID()}`,
      amountCents: input.amountCents ?? 0,
      payerEmail: input.payerEmail ?? null,
      previousAmountCents: input.previousAmountCents ?? null,
      statementId: input.statementId ?? null,
      paymentId: input.paymentId ?? null,
      refundIdsBefore: input.refundIdsBefore ?? null,
      state: 'marked',
      markedAt: input.now,
      settleUntil: new Date(input.now.getTime() + input.settleWindowMs),
    })
    .returning();
  if (!row) throw new Error('the attempt could not be recorded');
  return row;
}

/** The writes of the subscription that are open: sent (or about to be) and not resolved, or parked. */
export function openAttempts(tx: Tx, subscriptionId: string): Promise<SubscriptionAttemptRow[]> {
  return tx
    .select()
    .from(subscriptionAttempt)
    .where(
      and(
        eq(subscriptionAttempt.subscriptionId, subscriptionId),
        inArray(subscriptionAttempt.state, ['marked', 'parked']),
      ),
    )
    .orderBy(subscriptionAttempt.markedAt, subscriptionAttempt.id);
}

/** An attempt by its id, locked until the end of the transaction. */
export async function lockAttempt(tx: Tx, id: string): Promise<SubscriptionAttemptRow | null> {
  const [row] = await tx
    .select()
    .from(subscriptionAttempt)
    .where(eq(subscriptionAttempt.id, id))
    .for('update');
  return row ?? null;
}

export interface ResolveInput {
  state: Exclude<AttemptState, 'marked'>;
  resourceId?: string | null;
  resourceUrl?: string | null;
  message?: string | null;
  now: Date;
}

/** Closes an attempt as the provider's answer (or a search of it) decided. */
export async function resolveAttempt(
  tx: Tx,
  attempt: Pick<SubscriptionAttemptRow, 'id' | 'resourceId' | 'resourceUrl'>,
  input: ResolveInput,
): Promise<void> {
  await tx
    .update(subscriptionAttempt)
    .set({
      state: input.state,
      resourceId: input.resourceId ?? attempt.resourceId,
      resourceUrl: input.resourceUrl ?? attempt.resourceUrl,
      message: input.message ?? null,
      outcomeUnknown: false,
      // A parked attempt waits for a person, so it is not resolved.
      resolvedAt: input.state === 'parked' ? null : input.now,
    })
    .where(eq(subscriptionAttempt.id, attempt.id));
}

/**
 * Notes that the request was sent and the outcome is not known (a timeout, an abort, an answer that
 * did not come, an adapter that cannot tell). The pin stays: nothing is sent again, adopted blindly
 * or released until the settle window has passed and the provider has been asked.
 */
export async function noteUnknownOutcome(
  tx: Tx,
  attemptId: string,
  message: string | null,
): Promise<void> {
  await tx
    .update(subscriptionAttempt)
    .set({ outcomeUnknown: true, message })
    .where(eq(subscriptionAttempt.id, attemptId));
}

/**
 * Parks the subscription for a person: more than one resource could be ours, or one is not what was
 * asked. Nothing more is sent to the provider for it until somebody decides. The attempt is parked
 * too, and the cause is on the subscription, which is where the operator console reads it.
 */
export async function parkSubscription(
  tx: Tx,
  row: Pick<SubscriptionRow, 'id' | 'status' | 'attentionReason'>,
  reason: AttentionReason,
  now: Date,
): Promise<void> {
  if (row.attentionReason === null) {
    await tx
      .update(subscription)
      .set({ attentionReason: reason, attentionAt: now })
      .where(eq(subscription.id, row.id));
    await audit(tx, {
      action: 'subscription.state_changed',
      outcome: 'allow',
      actor: SYSTEM_ACTOR,
      resourceType: 'subscription',
      resourceId: row.id,
      reason: 'parked',
      metadata: { from: row.status, to: row.status, attention: reason },
    });
  }
}

/** Lets a subscription go again once a person decided (the operator, or a settled outcome). */
export async function clearAttention(tx: Tx, subscriptionId: string): Promise<void> {
  await tx
    .update(subscription)
    .set({ attentionReason: null, attentionAt: null })
    .where(and(eq(subscription.id, subscriptionId), eq(subscription.tenantId, CURRENT_TENANT)));
}

/** The number of the next attempt of a kind for a subscription (the reference carries it). */
export async function nextAttemptNumber(
  tx: Tx,
  subscriptionId: string,
  kind: AttemptKind,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(subscriptionAttempt)
    .where(
      and(
        eq(subscriptionAttempt.subscriptionId, subscriptionId),
        eq(subscriptionAttempt.kind, kind),
      ),
    );
  return (row?.count ?? 0) + 1;
}

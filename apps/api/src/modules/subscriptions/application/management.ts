import type { PlanDto } from '@consultorio/contracts';
import { and, asc, eq } from 'drizzle-orm';

import { userAccount } from '../../../db/schema/identity.js';
import {
  plan as planTable,
  subscription,
  subscriptionAttempt,
  subscriptionPayment,
  type SubscriptionRow,
} from '../../../db/schema/subscriptions.js';
import { tenant } from '../../../db/schema/tenant.js';
import { audit, type AuditActor } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { linkMatches } from '../domain/attempt-decisions.js';
import { coverageEnd } from '../domain/subscription-state.js';

import {
  lockAttempt,
  markAttempt,
  nextAttemptNumber,
  noteUnknownOutcome,
  openAttempts,
  parkSubscription,
  resolveAttempt,
} from './attempts.js';
import { cancelAtProvider } from './cancel-at-provider.js';
import { DAY_MS } from './common.js';
import type { CreatePaymentLinkResult } from './ports.js';
import { UNKNOWN_OUTCOME, callWithin, gatewayOf, type SubscriptionDeps } from './provider.js';
import { planDtoOf } from './read-model.js';
import { reconcileSubscription } from './reconcile.js';
import {
  CURRENT_TENANT,
  countActiveProfessionalsNow,
  findPlan,
  lockSubscription,
  readTenantBilling,
} from './store.js';
import { applyEvent } from './transitions.js';

/**
 * What the owner does with the subscription after it exists: changes the plan, cancels, takes the
 * cancellation back and pays what is overdue. Every write to the payments provider follows the same
 * three steps as the checkout (the mark, committed first; the call, with nothing held; the answer),
 * and an outcome that is not known is settled by the reconcile, never by a guess.
 */

interface Owner {
  tenantId: string;
  userId: string;
  actor: AuditActor;
}

const as = <T>(deps: SubscriptionDeps, owner: Owner, work: (tx: Tx) => Promise<T>) =>
  deps.withTenant({ tenantId: owner.tenantId, userId: owner.userId }, work);

// Plans ---------------------------------------------------------------------------------------

export async function listPlans(tx: Tx): Promise<PlanDto[]> {
  const rows = await tx
    .select()
    .from(planTable)
    .where(eq(planTable.active, true))
    .orderBy(asc(planTable.pricePerProfessionalCents), asc(planTable.key));
  return rows.map(planDtoOf);
}

export type ChangePlanOutcome =
  | { status: 'changed'; from: string; to: string }
  | { status: 'unchanged' }
  | { status: 'unknown_plan' }
  | { status: 'too_small'; max: number; active: number }
  | { status: 'not_allowed'; reason: 'exempt' | 'cancelled' | 'none' };

/**
 * `POST /subscription/plan`. The new plan must be active, and big enough for the professionals that
 * are active now (a plan never throws a professional out). The price follows at the next statement:
 * the plan change is recorded with its date and the audit trail, and the amount the provider charges
 * is changed only through a published statement.
 */
export async function changePlan(
  deps: SubscriptionDeps,
  owner: Owner,
  planKey: string,
): Promise<ChangePlanOutcome> {
  return as(deps, owner, async (tx) => {
    const billing = await readTenantBilling(tx);
    if (billing.exempt) return { status: 'not_allowed', reason: 'exempt' };
    const row = await lockSubscription(tx);
    if (!row) return { status: 'not_allowed', reason: 'none' };
    if (row.status === 'cancelled') return { status: 'not_allowed', reason: 'cancelled' };
    const [target] = await tx
      .select()
      .from(planTable)
      .where(and(eq(planTable.key, planKey), eq(planTable.active, true)));
    if (!target) return { status: 'unknown_plan' };
    if (target.id === row.planId) return { status: 'unchanged' };
    const active = await countActiveProfessionalsNow(tx);
    if (active > target.maxActiveProfessionals) {
      return { status: 'too_small', max: target.maxActiveProfessionals, active };
    }
    const current = await findPlan(tx, row.planId);
    await tx
      .update(subscription)
      .set({
        planId: target.id,
        // The cap never exceeds what the new plan allows.
        overageCapMessages: Math.min(row.overageCapMessages, target.overageCapMax),
        version: row.version + 1,
      })
      .where(eq(subscription.id, row.id));
    await audit(tx, {
      action: 'subscription.plan_changed',
      outcome: 'allow',
      actor: owner.actor,
      resourceType: 'subscription',
      resourceId: row.id,
      metadata: { from: current.key, to: target.key },
    });
    return { status: 'changed', from: current.key, to: target.key };
  });
}

// Cancel --------------------------------------------------------------------------------------

export type CancelOutcome =
  | { status: 'cancelling'; endsAt: Date }
  | { status: 'already_cancelling'; endsAt: Date }
  | { status: 'not_allowed'; reason: 'exempt' | 'cancelled' | 'none' };

/**
 * `POST /subscription/cancel`: the service continues until the end of the paid period (or of the
 * trial), nothing is deleted, and the preapproval is cancelled at the provider so that nothing more is
 * charged. The cancellation is the owner's decision and takes effect at once in the platform; the
 * provider is told afterwards, in its own steps, and when it cannot be reached the reconcile tells it
 * later (a cancelling subscription whose authorization is still in force is always retried).
 */
export async function requestCancellation(
  deps: SubscriptionDeps,
  owner: Owner,
): Promise<CancelOutcome> {
  const outcome = await as(deps, owner, async (tx): Promise<CancelOutcome> => {
    const billing = await readTenantBilling(tx);
    if (billing.exempt) return { status: 'not_allowed', reason: 'exempt' };
    const row = await lockSubscription(tx);
    if (!row) return { status: 'not_allowed', reason: 'none' };
    if (row.status === 'cancelled') return { status: 'not_allowed', reason: 'cancelled' };
    if (row.status === 'cancelling') {
      return { status: 'already_cancelling', endsAt: coverageEnd(row) };
    }
    const plan = await findPlan(tx, row.planId);
    const applied = await applyEvent({
      tx,
      row,
      plan,
      event: { type: 'cancel_requested' },
      now: deps.clock(),
      tenantCancelled: deps.tenantCancelled,
      actor: owner.actor,
    });
    return { status: 'cancelling', endsAt: coverageEnd(applied.row) };
  });
  if (outcome.status === 'cancelling') await cancelAtProvider(deps, owner.tenantId);
  return outcome;
}

// Reactivate ----------------------------------------------------------------------------------

export type ReactivateOutcome =
  | { status: 'reactivated' }
  /** The authorization is gone at the provider: the owner authorizes again on the checkout. */
  | { status: 'reauthorization_required' }
  /** A cancellation is being sent to the provider: wait for it. */
  | { status: 'in_progress' }
  | { status: 'unavailable' }
  | { status: 'not_allowed'; reason: 'exempt' | 'not_cancelling' };

/**
 * `POST /subscription/reactivate`: takes the cancellation back before the paid period ends. The
 * subscription goes back to active only when the provider CONFIRMS that the authorization is still in
 * force; when it is not (the cancellation reached the provider), the owner authorizes again, and the
 * confirmed authorization brings the subscription back to active by itself.
 */
export async function requestReactivation(
  deps: SubscriptionDeps,
  owner: Owner,
): Promise<ReactivateOutcome> {
  const gateway = gatewayOf(deps);
  const first = await as(deps, owner, async (tx) => {
    const billing = await readTenantBilling(tx);
    if (billing.exempt) return 'exempt' as const;
    const [row] = await tx
      .select()
      .from(subscription)
      .where(eq(subscription.tenantId, CURRENT_TENANT));
    if (row?.status !== 'cancelling') return 'not_cancelling' as const;
    const open = (await openAttempts(tx, row.id)).filter((attempt) => attempt.kind === 'cancel');
    if (open.length > 0) return 'in_progress' as const;
    return row;
  });
  if (first === 'exempt') return { status: 'not_allowed', reason: 'exempt' };
  if (first === 'not_cancelling') return { status: 'not_allowed', reason: 'not_cancelling' };
  if (first === 'in_progress') return { status: 'in_progress' };

  // What the provider holds now decides whether the authorization is still in force.
  let authorized = false;
  if (first.providerPreapprovalId !== null) {
    if (!gateway) return { status: 'unavailable' };
    const id = first.providerPreapprovalId;
    const asked = await callWithin(deps, (signal) => gateway.getPreapproval(id, signal), undefined);
    const lookup = asked.value;
    if (lookup === undefined || lookup.status === 'retryable') return { status: 'unavailable' };
    authorized = lookup.status === 'found' && lookup.preapproval.status === 'authorized';
  }

  return as(deps, owner, async (tx): Promise<ReactivateOutcome> => {
    const row = await lockSubscription(tx);
    if (row?.status !== 'cancelling') return { status: 'not_allowed', reason: 'not_cancelling' };
    const open = (await openAttempts(tx, row.id)).filter((attempt) => attempt.kind === 'cancel');
    if (open.length > 0) return { status: 'in_progress' };
    const plan = await findPlan(tx, row.planId);
    let current: SubscriptionRow = row;
    if (authorized) {
      const [updated] = await tx
        .update(subscription)
        .set({ authorizationState: 'authorized', version: row.version + 1 })
        .where(eq(subscription.id, row.id))
        .returning();
      if (updated) current = updated;
    }
    const applied = await applyEvent({
      tx,
      row: current,
      plan,
      event: { type: 'reactivated' },
      now: deps.clock(),
      tenantCancelled: deps.tenantCancelled,
      actor: owner.actor,
    });
    return applied.transition.changed
      ? { status: 'reactivated' }
      : { status: 'reauthorization_required' };
  });
}

// Pay what is overdue -------------------------------------------------------------------------

export type OverdueLinkOutcome =
  | { status: 'ready'; paymentUrl: string }
  | { status: 'unavailable' }
  | { status: 'in_progress' }
  | { status: 'attention' }
  | { status: 'rejected' }
  | { status: 'not_allowed'; reason: 'exempt' | 'nothing_due' };

const LINK_LIFETIME_DAYS = 7;

type Planned =
  | { kind: 'done'; outcome: OverdueLinkOutcome }
  | { kind: 'reconcile' }
  | {
      kind: 'send';
      attemptId: string;
      key: string;
      request: Parameters<NonNullable<ReturnType<typeof gatewayOf>>['createPaymentLink']>[0];
    };

/**
 * `POST /subscription/retry-payment`: a one-off link for the overdue amount, for an owner whose
 * subscription is past due or read-only. It is the owner's way to pay at any moment, whatever the
 * recurring charge is doing. The link is a write to the provider (mark, call, answer); a second click
 * hands out the link already made while it is valid and unpaid. The provider decides when it was paid:
 * the reconcile that follows the notice settles the debt.
 */
export async function createOverdueLink(
  deps: SubscriptionDeps,
  owner: Owner,
): Promise<OverdueLinkOutcome> {
  const gateway = gatewayOf(deps);
  if (!gateway) return { status: 'unavailable' };

  for (let pass = 0; pass < 3; pass += 1) {
    const step = await as(deps, owner, async (tx): Promise<Planned> => {
      const billing = await readTenantBilling(tx);
      if (billing.exempt)
        return { kind: 'done', outcome: { status: 'not_allowed', reason: 'exempt' } };
      const row = await lockSubscription(tx);
      if (row?.status !== 'past_due' && row?.status !== 'read_only') {
        return { kind: 'done', outcome: { status: 'not_allowed', reason: 'nothing_due' } };
      }
      if (row.attentionReason !== null) return { kind: 'done', outcome: { status: 'attention' } };
      const now = deps.clock();
      const open = (await openAttempts(tx, row.id)).filter(
        (attempt) =>
          attempt.kind === 'payment_link' && attempt.externalReference.startsWith('due:'),
      );
      for (const attempt of open) {
        if (attempt.state === 'parked') return { kind: 'done', outcome: { status: 'attention' } };
        if (now.getTime() < attempt.settleUntil.getTime()) {
          return { kind: 'done', outcome: { status: 'in_progress' } };
        }
        return { kind: 'reconcile' };
      }

      // The link already made, while it is valid and nobody paid it.
      const [made] = await tx
        .select()
        .from(subscriptionAttempt)
        .where(
          and(
            eq(subscriptionAttempt.subscriptionId, row.id),
            eq(subscriptionAttempt.kind, 'payment_link'),
            eq(subscriptionAttempt.state, 'confirmed'),
          ),
        )
        .orderBy(subscriptionAttempt.markedAt)
        .limit(50)
        .then((rows) =>
          rows.filter((candidate) => candidate.externalReference.startsWith('due:')).slice(-1),
        );
      if (
        made?.resourceUrl &&
        now.getTime() < made.markedAt.getTime() + LINK_LIFETIME_DAYS * DAY_MS
      ) {
        const paid = await tx
          .select({ id: subscriptionPayment.id })
          .from(subscriptionPayment)
          .where(
            and(
              eq(subscriptionPayment.subscriptionId, row.id),
              eq(subscriptionPayment.reference, made.externalReference),
              eq(subscriptionPayment.status, 'approved'),
            ),
          );
        if (paid.length === 0) {
          return { kind: 'done', outcome: { status: 'ready', paymentUrl: made.resourceUrl } };
        }
      }

      const plan = await findPlan(tx, row.planId);
      const amountCents =
        row.authorizedAmountCents ??
        Math.max(1, await countActiveProfessionalsNow(tx)) * plan.pricePerProfessionalCents;
      const [account] = await tx
        .select({ email: userAccount.email })
        .from(userAccount)
        .where(eq(userAccount.id, owner.userId));
      const [org] = await tx
        .select({ slug: tenant.slug })
        .from(tenant)
        .where(eq(tenant.id, CURRENT_TENANT));
      if (!account || !org || !deps.origins) throw new Error('the owner cannot be written to');
      const number = await nextAttemptNumber(tx, row.id, 'payment_link');
      const externalReference = `due:${row.id}:${String(number)}`;
      const attempt = await markAttempt(tx, {
        subscriptionId: row.id,
        kind: 'payment_link',
        externalReference,
        amountCents,
        payerEmail: account.email,
        now,
        settleWindowMs: gateway.settleWindowMs + (deps.providerTimeoutMs ?? 20_000),
      });
      return {
        kind: 'send',
        attemptId: attempt.id,
        key: attempt.idempotencyKey,
        request: {
          externalReference,
          payerEmail: account.email,
          title: `${plan.name} - pago pendiente`,
          amountCents,
          currency: 'ARS',
          backUrl: `${deps.origins(org.slug)}/subscription`,
          expiresAt: new Date(now.getTime() + LINK_LIFETIME_DAYS * DAY_MS).toISOString(),
        },
      };
    });

    if (step.kind === 'done') return step.outcome;
    if (step.kind === 'reconcile') {
      await reconcileSubscription(deps, owner.tenantId);
      continue;
    }

    const sent = await callWithin(
      deps,
      (signal) => gateway.createPaymentLink(step.request, step.key, signal),
      UNKNOWN_OUTCOME as CreatePaymentLinkResult,
    );
    const timedOut = sent.timedOut || sent.threw;
    return as(deps, owner, async (tx): Promise<OverdueLinkOutcome> => {
      const now = deps.clock();
      const row = await lockSubscription(tx);
      const attempt = await lockAttempt(tx, step.attemptId);
      if (!row || !attempt) throw new Error('the subscription disappeared');
      if (attempt.state !== 'marked') {
        return attempt.state === 'confirmed' && attempt.resourceUrl !== null
          ? { status: 'ready', paymentUrl: attempt.resourceUrl }
          : { status: attempt.state === 'parked' ? 'attention' : 'unavailable' };
      }
      const answer = sent.value;
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
          return { status: 'attention' };
        }
        await resolveAttempt(tx, attempt, {
          state: 'confirmed',
          resourceId: answer.link.linkId,
          resourceUrl: answer.link.url,
          now,
        });
        return { status: 'ready', paymentUrl: answer.link.url };
      }
      if (answer.status === 'rejected') {
        await resolveAttempt(tx, attempt, { state: 'rejected', now, message: answer.message });
        return { status: 'rejected' };
      }
      if (!answer.outcomeUnknown && !timedOut) {
        await resolveAttempt(tx, attempt, { state: 'released', now, message: answer.message });
      } else {
        await noteUnknownOutcome(tx, attempt.id, answer.message);
      }
      return { status: 'unavailable' };
    });
  }
  return { status: 'in_progress' };
}

// The overage cap -----------------------------------------------------------------------------------

export type OverageCapOutcome =
  | { status: 'set'; from: number; to: number }
  | { status: 'too_high'; max: number }
  | { status: 'not_allowed'; reason: 'exempt' | 'none' };

/**
 * `PATCH /subscription/overage-cap`: the most extra WhatsApp messages a period may bill, between zero
 * (overage off) and the maximum of the plan. It is never unlimited: the request carries a whole number,
 * and a number above the maximum is refused. The change is audited with the value before and after.
 */
export async function setOverageCap(
  deps: SubscriptionDeps,
  owner: Owner,
  cap: number,
): Promise<OverageCapOutcome> {
  return as(deps, owner, async (tx) => {
    const billing = await readTenantBilling(tx);
    if (billing.exempt) return { status: 'not_allowed', reason: 'exempt' };
    const row = await lockSubscription(tx);
    if (!row) return { status: 'not_allowed', reason: 'none' };
    const plan = await findPlan(tx, row.planId);
    if (!Number.isSafeInteger(cap) || cap < 0 || cap > plan.overageCapMax) {
      return { status: 'too_high', max: plan.overageCapMax };
    }
    if (cap !== row.overageCapMessages) {
      await tx
        .update(subscription)
        .set({ overageCapMessages: cap, version: row.version + 1 })
        .where(eq(subscription.id, row.id));
      await audit(tx, {
        action: 'subscription.cap_changed',
        outcome: 'allow',
        actor: owner.actor,
        resourceType: 'subscription',
        resourceId: row.id,
        metadata: { from: row.overageCapMessages, to: cap },
      });
    }
    return { status: 'set', from: row.overageCapMessages, to: cap };
  });
}

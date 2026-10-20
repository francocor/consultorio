import { DUNNING_RETRY_DAYS } from '@consultorio/contracts';
import { eq } from 'drizzle-orm';

import { subscription } from '../../../db/schema/subscriptions.js';
import { SYSTEM_USER_ID } from '../../../platform/db/tenant-context.js';
import { coverageEnd } from '../domain/subscription-state.js';

import { openAttempts } from './attempts.js';
import { DAY_MS } from './common.js';
import { claimNotice, sendPendingNotices } from './notices.js';
import type { SubscriptionDeps } from './provider.js';
import { reconcileSubscription } from './reconcile.js';
import { findPlan, findSubscription, lockSubscription, readTenantBilling } from './store.js';
import { applyEvent } from './transitions.js';

/**
 * The dates of the subscription: the end of the trial, the end of the grace and its reminders, and
 * the end of the paid period of a cancellation. These are the jobs `trial.end` and `dunning.step`.
 *
 * They are driven by TIME, not by what the provider failed to say:
 *
 * - **A date never advances anything by itself when the provider is the authority.** Before an
 *   organization turns past due, read-only or cancelled by a date, the provider is asked what it holds
 *   (a payment may have been approved a minute ago). When it cannot be asked, or an answer is not
 *   settled (a parked subscription, a write whose outcome is unknown), the step is SKIPPED: the state
 *   stays as it is and the next pass tries again. A provider outage never advances the dunning, never
 *   makes an organization read-only and never regresses a state.
 * - **Everything is idempotent.** A step is decided from the data (the dates and the counters of the
 *   subscription), not from a message that was delivered, so a job that ran twice, late or not at all
 *   ends in the same place; the notice of each step is claimed once.
 * - **An exempt organization has no subscription**, and nothing here touches it.
 */

export type ClockOutcome = 'skipped' | 'unavailable' | 'done';

async function snapshot(deps: SubscriptionDeps, tenantId: string) {
  return deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const billing = await readTenantBilling(tx);
    if (billing.exempt) return null;
    const sub = await findSubscription(tx);
    if (!sub) return null;
    return { sub, open: (await openAttempts(tx, sub.id)).length };
  });
}

/** Asks the provider before a date decides anything, when there is a provider to ask. */
async function askProvider(
  deps: SubscriptionDeps,
  tenantId: string,
  sub: { providerPreapprovalId: string | null },
  open: number,
): Promise<'ready' | 'unavailable'> {
  if (sub.providerPreapprovalId === null && open === 0) return 'ready';
  const result = await reconcileSubscription(deps, tenantId);
  return result.outcome === 'unavailable' ? 'unavailable' : 'ready';
}

/**
 * `trial.end`: a trial that ends with no subscription, and an active subscription whose paid time
 * ended with no authorization in force, turn past due: the grace of the plan begins and the owner is
 * emailed the date it becomes read-only. It also runs for an organization that is not active, because
 * the subscription is the owner's accounting.
 */
export async function runTrialEnd(deps: SubscriptionDeps, tenantId: string): Promise<ClockOutcome> {
  const snap = await snapshot(deps, tenantId);
  if (!snap) return 'skipped';
  const { sub } = snap;
  const now = deps.clock();
  const trialOver = sub.status === 'trial' && now.getTime() >= sub.trialEndsAt.getTime();
  const coverageOver =
    sub.status === 'active' &&
    sub.authorizationState !== 'authorized' &&
    now.getTime() >= coverageEnd(sub).getTime();
  if (!trialOver && !coverageOver) return 'skipped';
  // Parked for a person: nothing advances until somebody decides.
  if (sub.attentionReason !== null) return 'unavailable';
  if ((await askProvider(deps, tenantId, sub, snap.open)) === 'unavailable') return 'unavailable';

  await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const locked = await lockSubscription(tx);
    if (!locked || locked.attentionReason !== null) return;
    const plan = await findPlan(tx, locked.planId);
    let row = locked;
    for (const event of [{ type: 'trial_ended' }, { type: 'coverage_ended' }] as const) {
      row = (await applyEvent({ tx, row, plan, event, now, tenantCancelled: deps.tenantCancelled }))
        .row;
    }
  });
  await sendPendingNotices(deps, tenantId).catch(() => 0);
  return 'done';
}

/** The reminder (day 1, 3 or 5 after the first failure) that is owed now, or null. */
export function dueDunningStep(input: {
  firstFailureAt: Date;
  done: number;
  now: Date;
}): { index: number; day: 1 | 3 | 5 } | null {
  let due: { index: number; day: 1 | 3 | 5 } | null = null;
  for (let index = input.done; index < DUNNING_RETRY_DAYS.length; index += 1) {
    const day = DUNNING_RETRY_DAYS[index];
    if (day === undefined) break;
    if (input.now.getTime() >= input.firstFailureAt.getTime() + day * DAY_MS) {
      due = { index, day };
    }
  }
  return due;
}

/**
 * `dunning.step`: for a past due subscription, the reminders of day 1, 3 and 5 after the first
 * failure (each asks the provider where the charge stands first, and each emails the owner once), and
 * the end of the grace, which turns the organization read-only. For a read-only one it only asks the
 * provider, which is how a payment brings it back. For a cancelling one it ends the paid period.
 *
 * The queue never retries on its own (`retryLimit: 0`): a pass either did its step or skipped it, and
 * the clock tries the next one.
 */
export async function runDunningStep(
  deps: SubscriptionDeps,
  tenantId: string,
): Promise<ClockOutcome> {
  const snap = await snapshot(deps, tenantId);
  if (!snap) return 'skipped';
  const { sub } = snap;
  const now = deps.clock();

  if (sub.status === 'cancelling') {
    if (now.getTime() < coverageEnd(sub).getTime()) return 'skipped';
    await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
      const locked = await lockSubscription(tx);
      if (!locked) return;
      const plan = await findPlan(tx, locked.planId);
      await applyEvent({
        tx,
        row: locked,
        plan,
        event: { type: 'period_ended' },
        now,
        tenantCancelled: deps.tenantCancelled,
      });
    });
    return 'done';
  }

  if (sub.status !== 'past_due' && sub.status !== 'read_only') return 'skipped';
  if (sub.attentionReason !== null) return 'unavailable';
  // The provider first: a payment approved a minute ago settles everything below.
  if ((await askProvider(deps, tenantId, sub, snap.open)) === 'unavailable') return 'unavailable';

  await deps.withTenant({ tenantId, userId: SYSTEM_USER_ID }, async (tx) => {
    const locked = await lockSubscription(tx);
    if (!locked || locked.status !== 'past_due') return;
    const plan = await findPlan(tx, locked.planId);
    const expired = await applyEvent({
      tx,
      row: locked,
      plan,
      event: { type: 'grace_expired' },
      now,
      tenantCancelled: deps.tenantCancelled,
    });
    if (expired.transition.changed) return;

    const firstFailureAt =
      locked.firstFailureAt ??
      (locked.graceEndsAt === null
        ? now
        : new Date(locked.graceEndsAt.getTime() - plan.graceDays * DAY_MS));
    const step = dueDunningStep({ firstFailureAt, done: locked.dunningStep, now });
    if (step === null) return;
    await tx
      .update(subscription)
      .set({ dunningStep: step.index + 1, version: locked.version + 1 })
      .where(eq(subscription.id, locked.id));
    await claimNotice(
      tx,
      locked.id,
      `dunning_${String(step.day)}` as 'dunning_1',
      firstFailureAt.toISOString(),
    );
  });
  await sendPendingNotices(deps, tenantId).catch(() => 0);
  return 'done';
}

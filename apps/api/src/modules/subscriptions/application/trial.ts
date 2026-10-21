import { subscription } from '../../../db/schema/subscriptions.js';
import { audit } from '../../../platform/audit/writer.js';
import type { Tx } from '../../../platform/db/tenant-context.js';

import { SYSTEM_ACTOR, addDays } from './common.js';
import { findSubscription, readTenantBilling, startingPlan } from './store.js';

/**
 * The door the signup calls to start the trial of an organization that just verified its address
 * (`subscriptions.startTrial`, S6.02 and S6.11). It lives apart from the gateway because it is the
 * one thing the signup needs from billing, and the signup track builds against this type.
 */
export interface TrialStarter {
  /**
   * Starts the trial in the transaction of the verification, with the plan's trial length. An
   * exempt organization (a demo, a single-tenant deployment) never gets one: it answers `exempt`
   * and nothing is written. Asking again changes nothing: it answers `already_started` with the date
   * the first call set.
   */
  startTrial(tx: Tx, input: { tenantId: string }): Promise<StartTrialResult>;
}

export type StartTrialResult =
  | { status: 'started'; trialEndsAt: Date }
  | { status: 'already_started'; trialEndsAt: Date }
  | { status: 'exempt' };

export interface TrialStarterOptions {
  clock?: () => Date;
}

/**
 * Creates the subscription of an organization in `trial` (the plan's trial length, 14 days by
 * default) and writes `subscription.created`. It is idempotent: the unique key on the organization
 * makes a second call, or two at the same time, find the row that is there.
 */
export function createTrialStarter(options: TrialStarterOptions = {}): TrialStarter {
  const clock = options.clock ?? (() => new Date());
  return {
    async startTrial(tx, input) {
      const billing = await readTenantBilling(tx);
      if (billing.id !== input.tenantId) {
        throw new Error('the trial is started in the transaction of the organization');
      }
      if (billing.exempt) return { status: 'exempt' };

      const existing = await findSubscription(tx);
      if (existing) return { status: 'already_started', trialEndsAt: existing.trialEndsAt };

      const plan = await startingPlan(tx);
      const trialEndsAt = addDays(clock(), plan.trialDays);
      const [created] = await tx
        .insert(subscription)
        .values({
          tenantId: input.tenantId,
          planId: plan.id,
          status: 'trial',
          trialEndsAt,
          overageCapMessages: plan.overageCapDefault,
        })
        .onConflictDoNothing({ target: subscription.tenantId })
        .returning({ id: subscription.id });
      if (!created) {
        // Another transaction started it first (the unique key on the organization).
        const winner = await findSubscription(tx);
        if (!winner) throw new Error('the subscription of the organization could not be created');
        return { status: 'already_started', trialEndsAt: winner.trialEndsAt };
      }
      await audit(tx, {
        action: 'subscription.created',
        outcome: 'allow',
        actor: SYSTEM_ACTOR,
        resourceType: 'subscription',
        resourceId: created.id,
        metadata: { plan: plan.key, status: 'trial', trialDays: plan.trialDays },
      });
      return { status: 'started', trialEndsAt };
    },
  };
}

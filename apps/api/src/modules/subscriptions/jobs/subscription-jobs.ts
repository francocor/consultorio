import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob, type JobDefinition } from '../../../platform/jobs/define-job.js';
import { runDunningStep, runTrialEnd } from '../application/clock.js';
import {
  DUNNING_STEP_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  TRIAL_END_JOB,
} from '../application/job-names.js';
import type { SubscriptionDeps } from '../application/provider.js';
import { reconcileSubscription } from '../application/reconcile.js';

export { DUNNING_STEP_JOB, SUBSCRIPTION_RECONCILE_JOB, TRIAL_END_JOB };

export interface SubscriptionJobs {
  reconcile: JobDefinition;
  trialEnd: JobDefinition;
  dunningStep: JobDefinition;
  /** All of them, to register them (or to run them in a test). */
  definitions: readonly JobDefinition[];
}

/**
 * The jobs of the subscriptions module.
 *
 * - `subscription.reconcile`: asks the payments provider where the subscription of the organization
 *   stands and writes the answer. Queued by the webhook (a notice only nudges) and by a clock every few
 *   minutes, which is also how an outage heals. Category `webhook`: it keeps running in a read-only
 *   organization, because paying is how it recovers.
 *
 * - `trial.end`: a trial that ended with no subscription (or paid time that ended with no authorization)
 *   becomes past due, and the owner is emailed the date it becomes read-only. Category `subscription`:
 *   it runs also when the organization is read-only or cancelled, because the subscription is the
 *   owner's accounting.
 * - `dunning.step`: the reminders of day 1, 3 and 5, the end of the grace (read-only) and the end of
 *   a cancelled paid period. Category `subscription`, and it never retries on its own
 *   (`retryLimit: 0`): a pass either does its step or skips it, and the clock tries the next one.
 *
 * An exempt organization has no subscription and these jobs do nothing for it.
 *
 * The transaction `runJob` opens for the handler is NOT used for the work: the handler runs its own
 * short transactions (`deps.withTenant`) between the questions to the provider, so the framework
 * transaction stays idle while the provider is waited for. That connection is counted in the floor of
 * the pool: `subscription.reconcile` is in `CONNECTION_HOLDING_JOBS`.
 */
export function createSubscriptionJobs(deps: SubscriptionDeps): SubscriptionJobs {
  const reconcile = defineJob({
    name: SUBSCRIPTION_RECONCILE_JOB,
    category: 'webhook',
    payload: JobPayload,
    async handler({ tenantId }) {
      await reconcileSubscription(deps, tenantId);
    },
  });
  const trialEnd = defineJob({
    name: TRIAL_END_JOB,
    category: 'subscription',
    payload: JobPayload,
    async handler({ tenantId }) {
      await runTrialEnd(deps, tenantId);
    },
  });
  const dunningStep = defineJob({
    name: DUNNING_STEP_JOB,
    category: 'subscription',
    payload: JobPayload,
    async handler({ tenantId }) {
      await runDunningStep(deps, tenantId);
    },
  });
  return {
    reconcile,
    trialEnd,
    dunningStep,
    definitions: [reconcile, trialEnd, dunningStep] as readonly JobDefinition[],
  };
}

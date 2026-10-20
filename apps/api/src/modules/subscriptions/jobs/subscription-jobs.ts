import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob, type JobDefinition } from '../../../platform/jobs/define-job.js';
import { runDunningStep, runTrialEnd } from '../application/clock.js';
import {
  DUNNING_STEP_JOB,
  STATEMENT_GENERATE_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  TRIAL_END_JOB,
  USAGE_SNAPSHOT_JOB,
} from '../application/job-names.js';
import { sendPendingNotices } from '../application/notices.js';
import type { SubscriptionDeps } from '../application/provider.js';
import { reconcileSubscription } from '../application/reconcile.js';
import { generateStatements } from '../application/statements.js';
import { runUsageSnapshot } from '../application/usage.js';

export {
  DUNNING_STEP_JOB,
  STATEMENT_GENERATE_JOB,
  SUBSCRIPTION_RECONCILE_JOB,
  TRIAL_END_JOB,
  USAGE_SNAPSHOT_JOB,
};

export interface SubscriptionJobs {
  reconcile: JobDefinition;
  trialEnd: JobDefinition;
  dunningStep: JobDefinition;
  usageSnapshot: JobDefinition;
  statementGenerate: JobDefinition;
  /** The jobs of a deployment that bills organizations (all of them). */
  billing: readonly JobDefinition[];
  /** The jobs of a deployment that only meters (a single-tenant one with billing off). */
  metering: readonly JobDefinition[];
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
 * - `usage.snapshot`: writes the day each professional was active and the count of accepted WhatsApp
 *   messages, and sends the notice of an exhausted quota that was claimed since. Category
 *   `subscription`. It asks no provider.
 * - `statement.generate`: writes the statement of every closed period that has none and tells the owner
 *   (the statements keep being published in a read-only organization). It asks no provider either, so
 *   neither is a connection-holding family.
 *
 * An exempt organization has no subscription and the billing jobs do nothing for it.
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
  const usageSnapshot = defineJob({
    name: USAGE_SNAPSHOT_JOB,
    category: 'subscription',
    payload: JobPayload,
    async handler({ tenantId }) {
      await runUsageSnapshot(deps, tenantId);
      await sendPendingNotices(deps, tenantId).catch(() => 0);
    },
  });
  const statementGenerate = defineJob({
    name: STATEMENT_GENERATE_JOB,
    category: 'subscription',
    payload: JobPayload,
    async handler({ tenantId }) {
      await generateStatements(deps, tenantId);
    },
  });
  const billing = [
    reconcile,
    trialEnd,
    dunningStep,
    usageSnapshot,
    statementGenerate,
  ] as readonly JobDefinition[];
  return {
    reconcile,
    trialEnd,
    dunningStep,
    usageSnapshot,
    statementGenerate,
    billing,
    metering: [usageSnapshot] as readonly JobDefinition[],
    definitions: billing,
  };
}

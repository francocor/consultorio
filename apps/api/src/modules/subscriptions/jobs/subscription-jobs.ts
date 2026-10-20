import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob, type JobDefinition } from '../../../platform/jobs/define-job.js';
import { SUBSCRIPTION_RECONCILE_JOB } from '../application/job-names.js';
import type { SubscriptionDeps } from '../application/provider.js';
import { reconcileSubscription } from '../application/reconcile.js';

export { SUBSCRIPTION_RECONCILE_JOB };

export interface SubscriptionJobs {
  reconcile: JobDefinition;
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
  return { reconcile, definitions: [reconcile] as readonly JobDefinition[] };
}

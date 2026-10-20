/** The queue that asks the payments provider where a subscription stands and writes the answer. */
export const SUBSCRIPTION_RECONCILE_JOB = 'subscription.reconcile';

/** The queue that turns a trial (or a paid time) that ended into the grace period of the plan. */
export const TRIAL_END_JOB = 'trial.end';

/**
 * The queue of the reminders of the grace (day 1, 3 and 5), of its end, and of the end of a paid
 * period that was cancelled. Its queue never retries on its own: a pass does its step or skips it.
 */
export const DUNNING_STEP_JOB = 'dunning.step';

/**
 * The queue that meters the subscription: the day each active professional was active, and the count
 * of WhatsApp messages the provider accepted. It also runs where billing is off (a single-tenant
 * deployment), because the counts feed the contract invoicing of the operator.
 */
export const USAGE_SNAPSHOT_JOB = 'usage.snapshot';

/** The queue that writes the statement of every period that closed, and tells the owner. */
export const STATEMENT_GENERATE_JOB = 'statement.generate';

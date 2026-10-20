import type { Tx } from '../../../platform/db/tenant-context.js';

/**
 * The door the signup calls to start the trial of an organization that just verified its address
 * (`subscriptions.startTrial`, S6.02 and S6.11). It lives apart from the gateway because it is the
 * one thing the signup needs from billing, and the signup track builds against this type while the
 * subscriptions track builds the real one.
 */
export interface TrialStarter {
  /**
   * Starts the trial in the transaction of the verification, with the plan's trial length. An
   * exempt organization (a demo, a single-tenant deployment) never gets one: it answers `exempt`
   * and nothing is written.
   */
  startTrial(tx: Tx, input: { tenantId: string }): Promise<StartTrialResult>;
}

export type StartTrialResult =
  | { status: 'started'; trialEndsAt: Date }
  | { status: 'already_started'; trialEndsAt: Date }
  | { status: 'exempt' };

/**
 * What the seam hands out until S6.01 exists: it refuses, so a signup that is verified before the
 * subscriptions track has landed fails loudly and rolls back instead of activating an organization
 * with no trial and no plan.
 */
export const unbuiltTrialStarter: TrialStarter = {
  startTrial: () =>
    Promise.reject(new Error('subscriptions.startTrial is built by S6.01 (subscriptions track)')),
};

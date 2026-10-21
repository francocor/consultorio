/**
 * Tenant tables of Stage 6 that the demonstration organization leaves empty ON PURPOSE (task 6.47).
 * The slice that seeds Stage 6 replaced the three lists the tracks kept (`subscriptions.ts`,
 * `signup.ts`, `retention.ts`) with this one, entry by entry, with the reason it is final:
 *
 * - **The subscription.** A demonstration organization is billed outside the platform (billing
 *   exempt): the database refuses a subscription row for it, and every table below hangs from one.
 *   Its exempt state is what the demo shows (`seedStage6` checks it), and the four organizations of
 *   `pnpm demo:platform` have a subscription in each state, with its attempts, payments and notices
 *   (`demo-platform.test.ts`).
 * - **The signup.** A demonstration organization is created by the operator, never by a signup.
 * - **The retention.** A demonstration organization is never cancelled: its end is the demo reset,
 *   which keeps its rows. The cancellation export and the archive belong to an organization that
 *   leaves.
 */
export const exemptions: Record<string, string> = {
  subscription:
    'A demonstration organization is billed outside the platform (billing exempt): the database refuses a subscription for it. The organizations of `pnpm demo:platform` have one in each state.',
  subscription_event:
    'The notices of the payments provider that moved a subscription (webhooks); a demonstration organization has no subscription.',
  subscription_attempt:
    'The attempts to reach the payments provider for a subscription; a demonstration organization has no subscription.',
  subscription_notice:
    'The notices to the owner about the subscription (trial end, dunning); a demonstration organization has no subscription.',
  subscription_payment:
    'The charges of a subscription; a demonstration organization is never charged.',
  subscription_refund:
    'The refunds of the charges of a subscription; a demonstration organization is never charged.',
  statement:
    'The monthly statement is made for a subscription; a demonstration organization has none.',
  usage_record:
    'The daily usage counts feed the statements of a subscription; a demonstration organization has none.',
  signup_pending:
    'A signup waiting for its link: it exists only for an organization that was never confirmed, and a demonstration organization is created by the operator, not by a signup.',
  terms_acceptance:
    'The acceptance of the terms is written when the owner of a self-service signup verifies the address; a demonstration organization has no signup.',
  export_package:
    'Made when an organization is cancelled. A demonstration organization is never cancelled: its end is the demo reset.',
  archive_key:
    'The key pair of the retention archive is made when an organization is archived. A demonstration organization is never archived.',
  tenant_archive:
    'Written when the archive of a cancelled organization is made. A demonstration organization is never archived.',
};

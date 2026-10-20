/**
 * Tenant tables of the Stage 6 subscriptions (track A) that the demo seed leaves empty on purpose. A
 * demonstration organization is exempt from billing: it has no subscription, so nothing below exists
 * for it. Track D removes an entry only if the demo of Stage 6 (S6.12) seeds the table.
 */
export const exemptions: Record<string, string> = {
  subscription:
    'A demonstration organization is billed outside the platform (billing exempt): the database refuses a subscription for it.',
  subscription_event: 'The history of a subscription; a demonstration organization has none.',
  subscription_attempt:
    'The attempts to reach the payments provider for a subscription; a demonstration organization has none.',
  subscription_notice:
    'The notices of the payments provider about a subscription; a demonstration organization has none.',
  subscription_payment:
    'The charges of a subscription; a demonstration organization is never charged.',
  subscription_refund:
    'The refunds of the charges of a subscription; a demonstration organization is never charged.',
  statement:
    'The monthly statement is made for a subscription; a demonstration organization has none.',
  usage_record:
    'The daily usage counts feed the statements of a subscription; a demonstration organization has none.',
};

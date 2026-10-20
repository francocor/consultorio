/**
 * The error codes and audit actions of the subscriptions module (plans, the subscription of an
 * organization, payments through the gateway, statements, usage and the overage cap), apart from its
 * schemas (see `billing-catalog.ts` for why they live apart).
 */

/**
 * Error codes of the subscriptions module, with their status and the key of the es-AR message. They
 * join the API catalog (errors.ts); the messages go in `locales/es-AR/errors.subscriptions.json`,
 * keyed by the code. The subscriptions track (Track A) adds its codes here and nowhere else.
 */
export const SUBSCRIPTION_ERRORS = {
  // The plan allows no more active professionals: the message offers a plan change.
  subscription_professional_limit: {
    status: 409,
    i18nKey: 'errors.subscription_professional_limit',
  },
} as const satisfies Record<string, { status: number; i18nKey: string }>;

/**
 * Audit actions of the subscription of an organization. They are registered in the shared
 * catalogue. The metadata of an entry names the plan, the states, the counts and the id the
 * provider gave an event, never a card, a token or the secret of a webhook.
 */
export const SUBSCRIPTION_AUDIT_ACTIONS = [
  'subscription.created',
  'subscription.plan_changed',
  'subscription.state_changed',
  'subscription.cap_changed',
  // A second approved payment for a period that was already paid: recorded and flagged, not collected.
  'subscription.surplus_flagged',
  'subscription.refunded',
] as const;

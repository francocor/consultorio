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
  // The payments provider is down, did not answer or is not configured: nothing changed, try again.
  subscription_payments_unavailable: {
    status: 503,
    i18nKey: 'errors.subscription_payments_unavailable',
  },
  // A request to the provider is in flight, or its outcome is not known yet: wait, do not send another.
  subscription_checkout_in_progress: {
    status: 409,
    i18nKey: 'errors.subscription_checkout_in_progress',
  },
  // The subscription is parked for a person: the provider holds something the platform cannot tell apart.
  subscription_needs_attention: { status: 409, i18nKey: 'errors.subscription_needs_attention' },
  // The provider refused the request for good.
  subscription_checkout_rejected: { status: 422, i18nKey: 'errors.subscription_checkout_rejected' },
  // A demo, or a deployment that bills outside the platform, has no subscription.
  subscription_exempt: { status: 409, i18nKey: 'errors.subscription_exempt' },
  subscription_cancelled: { status: 409, i18nKey: 'errors.subscription_cancelled' },
  subscription_already_subscribed: {
    status: 409,
    i18nKey: 'errors.subscription_already_subscribed',
  },
  // The plan chosen has room for fewer professionals than are active now.
  subscription_plan_too_small: { status: 409, i18nKey: 'errors.subscription_plan_too_small' },
  // The authorization is gone at the provider: the owner authorizes again to take the cancellation back.
  subscription_reauthorization_required: {
    status: 409,
    i18nKey: 'errors.subscription_reauthorization_required',
  },
  // There is nothing overdue to pay.
  subscription_nothing_due: { status: 409, i18nKey: 'errors.subscription_nothing_due' },
  // The subscription is not being cancelled, so there is nothing to take back.
  subscription_not_cancelling: { status: 409, i18nKey: 'errors.subscription_not_cancelling' },
  // The cap of overage messages is above the maximum of the plan.
  subscription_overage_cap_too_high: {
    status: 422,
    i18nKey: 'errors.subscription_overage_cap_too_high',
  },
  // The organization has no subscription to set a cap on.
  subscription_not_found: { status: 404, i18nKey: 'errors.subscription_not_found' },
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
  // A preapproval that was superseded or that charged next to the one the subscription holds was
  // cancelled at the provider (the metadata says which and why).
  'subscription.preapproval_cancelled',
  // The platform operator looked at a subscription parked for a person and let it go, with a reason.
  'subscription.parked_resolved',
  // The platform operator looked at a payment flagged as a surplus and decided (refund it, or leave it).
  'subscription.surplus_reviewed',
] as const;

/**
 * What the platform operator does to the billing of an organization, written in the platform trail
 * with the operator's id (the same entry is written in the trail of the organization, which is part of
 * what it takes with it). The operator never reads a payer or a card: the entries carry the ids of
 * the platform and of the provider, the amounts and the reason the operator gave.
 */
export const SUBSCRIPTION_PLATFORM_AUDIT_ACTIONS = [
  'subscription.parked_resolved',
  'subscription.refunded',
  'subscription.surplus_reviewed',
] as const;

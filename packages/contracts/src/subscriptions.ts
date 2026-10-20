export { SUBSCRIPTION_ERRORS, SUBSCRIPTION_AUDIT_ACTIONS } from './subscriptions-catalog.js';

/**
 * Contracts of the subscriptions module (the platform subscription of an organization: plans, the
 * lifecycle from trial to cancelled, payments through the gateway, statements, usage and the
 * overage cap). This file holds what is certain from the design (sections 3.5 and 7); the
 * subscriptions track (S6.01, S6.03 to S6.07) adds its request and response shapes below, in this
 * file only. No shape here may carry a card number, a token or the secret of a webhook: the payer
 * enters the card on the hosted page of the provider, and the platform keeps only its label.
 */

/** Where the subscription of an organization stands. The order is the one of the lifecycle. */
export const SUBSCRIPTION_STATUSES = [
  'trial',
  'active',
  'past_due',
  'read_only',
  'cancelling',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * `tenant.status` is derived from the subscription, never set on its own (design section 7):
 * `read_only` follows the subscription's `read_only`, `cancelled` follows `cancelled`, and every
 * other state keeps the organization active. An exempt organization has no subscription.
 */
export const TENANT_STATUS_OF_SUBSCRIPTION = {
  trial: 'active',
  active: 'active',
  past_due: 'active',
  read_only: 'read_only',
  cancelling: 'active',
  cancelled: 'cancelled',
} as const satisfies Record<SubscriptionStatus, 'active' | 'read_only' | 'cancelled'>;

/**
 * What a plan says when nobody changed it (prices are configuration, in the plan table). The trial
 * and the grace period are in days; the quota is messages per active professional per month.
 */
export const PLAN_DEFAULTS = {
  trialDays: 14,
  graceDays: 7,
  whatsappQuotaPerProfessional: 200,
} as const;

/** The days after the first failure on which the charge is tried again (dunning). */
export const DUNNING_RETRY_DAYS = [1, 3, 5] as const;

/** A statement is collected at least this many days after it is published. */
export const STATEMENT_COLLECTION_DELAY_DAYS = 3;

/**
 * The modes of a payments simulator. `ok`, `down`, `refuse_amount_change`, `lose_answer` and
 * `reauthorize` are failures of the gateway (the fake and the local Mercado Pago both have them);
 * `duplicate_events` and `out_of_order` change how the local simulator delivers its webhooks.
 */
export const PAYMENTS_SIMULATOR_MODES = [
  'ok',
  'down',
  'refuse_amount_change',
  'duplicate_events',
  'out_of_order',
  'lose_answer',
  'reauthorize',
] as const;
export type PaymentsSimulatorMode = (typeof PAYMENTS_SIMULATOR_MODES)[number];

import { z } from 'zod';

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

// The plan and the subscription as the owner sees them --------------------------------------------

const Instant = z.iso.datetime({ offset: true });
/** Whole cents of ARS. */
const Cents = z.number().int().min(0);
const Count = z.number().int().min(0);

/** A plan of the platform: configuration, never code. */
export const PlanDto = z.strictObject({
  key: z.string(),
  name: z.string(),
  currency: z.literal('ARS'),
  pricePerProfessionalCents: Cents,
  maxActiveProfessionals: z.number().int().min(1),
  whatsappQuotaPerProfessional: Count,
  overageUnitPriceCents: Cents,
  overageCapDefault: Count,
  /** The platform maximum of the overage cap. */
  overageCapMax: Count,
  trialDays: Count,
  graceDays: z.number().int().min(1),
});
export type PlanDto = z.infer<typeof PlanDto>;

/** What happens next to the subscription, and when (the owner sees the date of the next transition). */
export const SUBSCRIPTION_NEXT_TRANSITIONS = [
  'trial_ends',
  'read_only_at',
  'service_ends',
  'next_charge',
] as const;
export type SubscriptionNextTransitionKind = (typeof SUBSCRIPTION_NEXT_TRANSITIONS)[number];

export const SubscriptionNextTransition = z.strictObject({
  kind: z.enum(SUBSCRIPTION_NEXT_TRANSITIONS),
  at: Instant,
});
export type SubscriptionNextTransition = z.infer<typeof SubscriptionNextTransition>;

export const AUTHORIZATION_STATE_VALUES = ['none', 'pending', 'authorized', 'lost'] as const;

/**
 * The subscription of an organization. It carries the label the provider gives to the payment method
 * and never a card number or a token.
 */
export const SubscriptionDto = z.strictObject({
  status: z.enum(SUBSCRIPTION_STATUSES),
  plan: PlanDto,
  trialEndsAt: Instant,
  graceEndsAt: Instant.nullable(),
  paidThrough: Instant.nullable(),
  nextTransition: SubscriptionNextTransition.nullable(),
  authorization: z.enum(AUTHORIZATION_STATE_VALUES),
  paymentMethodLabel: z.string().nullable(),
  /** When the provider says it charges next, and the monthly amount the owner authorized. */
  nextChargeAt: Instant.nullable(),
  authorizedAmountCents: Cents.nullable(),
  overageCapMessages: Count,
  /** Active professionals today, and what they cost in a full month. */
  activeProfessionals: Count,
  monthlyPriceCents: Cents,
  /** The provider's answer is not known for sure: the owner is told, nothing is guessed. */
  needsAttention: z.boolean(),
});
export type SubscriptionDto = z.infer<typeof SubscriptionDto>;

/**
 * `GET /subscription`. An exempt organization (a demo, a deployment without billing) has no
 * subscription and no plan: `exempt` is true and the screen says "account without billing". An
 * organization that is not exempt and has no subscription yet gets `subscription: null` and the
 * plan it would start on.
 */
export const SubscriptionResponse = z.strictObject({
  exempt: z.boolean(),
  subscription: SubscriptionDto.nullable(),
  /** The plan a subscription would start on; null for an exempt organization. */
  plan: PlanDto.nullable(),
  /** The payments provider is a simulator: every screen says so. */
  simulated: z.boolean(),
});
export type SubscriptionResponse = z.infer<typeof SubscriptionResponse>;

/** What adding professionals does to the price, shown before the owner confirms. */
export const PlanImpactQuery = z.strictObject({
  professionals: z.coerce.number().int().min(1).max(20).default(1),
});
export type PlanImpactQuery = z.infer<typeof PlanImpactQuery>;

export const PlanImpactResponse = z.strictObject({
  /** False where there is no plan (an exempt organization): nothing changes the price. */
  affectsPlan: z.boolean(),
  activeProfessionals: z.strictObject({ now: Count, after: Count }),
  monthlyCents: z.strictObject({ now: Cents, after: Cents }),
  monthlyDifferenceCents: Cents,
  /** What the professionals added cost for the rest of this period, prorated by the day. */
  proratedThisPeriodCents: Cents,
  daysLeft: Count,
  daysInPeriod: Count,
  /** The period ends on this billing day (YYYY-MM-DD). */
  periodEndsOn: z.string(),
  limit: z.strictObject({ max: Count, reached: z.boolean() }),
});
export type PlanImpactResponse = z.infer<typeof PlanImpactResponse>;

/** What the platform operator sees of a subscription: state, dates and counts, never a person. */
export const OperatorSubscriptionDto = z.strictObject({
  /** The organization the subscription belongs to. */
  id: z.uuid(),
  status: z.enum(SUBSCRIPTION_STATUSES),
  planKey: z.string(),
  trialEndsAt: Instant,
  graceEndsAt: Instant.nullable(),
  paidThrough: Instant.nullable(),
  dunningStep: Count,
  authorization: z.enum(AUTHORIZATION_STATE_VALUES),
  overageCapMessages: Count,
  /** Why the subscription is parked for a person, or null. */
  attentionReason: z.string().nullable(),
  /** Payments flagged as a surplus and not reviewed yet. */
  surplusFlags: Count,
});
export type OperatorSubscriptionDto = z.infer<typeof OperatorSubscriptionDto>;

export const OperatorSubscriptionsResponse = z.strictObject({
  subscriptions: z.array(OperatorSubscriptionDto),
});
export type OperatorSubscriptionsResponse = z.infer<typeof OperatorSubscriptionsResponse>;

// The local Mercado Pago simulator (provider console) ---------------------------------------------

export const PaymentsSimulatorModeRequest = z.strictObject({
  mode: z.enum(PAYMENTS_SIMULATOR_MODES),
});
export type PaymentsSimulatorModeRequest = z.infer<typeof PaymentsSimulatorModeRequest>;

/** A preapproval the simulator holds, as the console lists it (no payer, no card). */
export const PaymentsSimulatorPreapprovalDto = z.strictObject({
  preapprovalId: z.string(),
  reference: z.string(),
  status: z.enum(['pending', 'authorized', 'paused', 'cancelled']),
  amountCents: Cents,
  createdAt: Instant,
});
export type PaymentsSimulatorPreapprovalDto = z.infer<typeof PaymentsSimulatorPreapprovalDto>;

export const PaymentsSimulatorPaymentDto = z.strictObject({
  paymentId: z.string(),
  reference: z.string(),
  status: z.string(),
  amountCents: Cents,
  refundedCents: Cents,
  createdAt: Instant,
});
export type PaymentsSimulatorPaymentDto = z.infer<typeof PaymentsSimulatorPaymentDto>;

export const PaymentsSimulatorStateResponse = z.strictObject({
  mode: z.enum(PAYMENTS_SIMULATOR_MODES),
  /** The newest first. */
  preapprovals: z.array(PaymentsSimulatorPreapprovalDto),
  payments: z.array(PaymentsSimulatorPaymentDto),
});
export type PaymentsSimulatorStateResponse = z.infer<typeof PaymentsSimulatorStateResponse>;

/** "Run the billing cycle": the provider charges every authorized preapproval now. */
export const PaymentsSimulatorCycleRequest = z.strictObject({
  outcome: z.enum(['approved', 'rejected']).default('approved'),
});
export type PaymentsSimulatorCycleRequest = z.infer<typeof PaymentsSimulatorCycleRequest>;

export const PaymentsSimulatorCycleResponse = z.strictObject({
  /** How many payments the cycle made. */
  charged: Count,
  /** How many notices the webhook accepted. */
  delivered: Count,
});
export type PaymentsSimulatorCycleResponse = z.infer<typeof PaymentsSimulatorCycleResponse>;

// Checkout -------------------------------------------------------------------------------------------

/** `POST /subscription/checkout`: where the owner authorizes the monthly payment (the provider's page). */
export const CheckoutResponse = z.strictObject({ checkoutUrl: z.url() });
export type CheckoutResponse = z.infer<typeof CheckoutResponse>;

import { SUBSCRIPTION_STATUSES } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * The plans of the platform (subscriptions, "Plan catalog and limits"). A plan is configuration, not
 * code: the price per active professional, the most professionals, the WhatsApp quota of each one,
 * the price of an extra message, the default and the platform maximum of the overage cap, and the
 * lengths of the trial and of the grace. Amounts are whole cents of ARS.
 *
 * Platform table: no `tenant_id`, no row level security. Every organization reads it; the runtime
 * role cannot write it (the migration revokes), and the platform operator maintains it as data. A
 * plan is retired (`active = false`), never deleted: a subscription points at it.
 */
export const plan = pgTable(
  'plan',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    /** Lowercase words joined by hyphens: how a configuration or a person names the plan. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    currency: text('currency').notNull().default('ARS'),
    pricePerProfessionalCents: bigint('price_per_professional_cents', { mode: 'number' }).notNull(),
    maxActiveProfessionals: integer('max_active_professionals').notNull(),
    whatsappQuotaPerProfessional: integer('whatsapp_quota_per_professional').notNull().default(200),
    overageUnitPriceCents: integer('overage_unit_price_cents').notNull(),
    overageCapDefault: integer('overage_cap_default').notNull(),
    /** The platform maximum: an owner may set the cap of the organization up to it, never above. */
    overageCapMax: integer('overage_cap_max').notNull(),
    trialDays: integer('trial_days').notNull().default(14),
    graceDays: integer('grace_days').notNull().default(7),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique('plan_key_key').on(table.key),
    check('plan_key_check', sql`${table.key} ~ '^[a-z][a-z0-9-]{0,39}$'`),
    check('plan_currency_check', sql`${table.currency} = 'ARS'`),
    check('plan_price_check', sql`${table.pricePerProfessionalCents} >= 0`),
    check('plan_max_professionals_check', sql`${table.maxActiveProfessionals} >= 1`),
    check('plan_quota_check', sql`${table.whatsappQuotaPerProfessional} >= 0`),
    check('plan_overage_price_check', sql`${table.overageUnitPriceCents} >= 0`),
    check(
      'plan_overage_cap_check',
      sql`${table.overageCapDefault} >= 0 and ${table.overageCapDefault} <= ${table.overageCapMax}`,
    ),
    check('plan_trial_days_check', sql`${table.trialDays} >= 0`),
    check('plan_grace_days_check', sql`${table.graceDays} >= 1`),
  ],
);

export type PlanRow = typeof plan.$inferSelect;

/**
 * What else a plan gives or limits, by feature (`limit_value` null: the feature is included with no
 * limit of its own). Platform table, like `plan`.
 */
export const planEntitlement = pgTable(
  'plan_entitlement',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    planId: uuid('plan_id').notNull(),
    feature: text('feature').notNull(),
    limitValue: integer('limit_value'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'plan_entitlement_plan_fkey',
      columns: [table.planId],
      foreignColumns: [plan.id],
    }),
    unique('plan_entitlement_plan_feature_key').on(table.planId, table.feature),
    check('plan_entitlement_feature_check', sql`${table.feature} ~ '^[a-z][a-z0-9_]{0,59}$'`),
    check(
      'plan_entitlement_limit_check',
      sql`${table.limitValue} is null or ${table.limitValue} >= 0`,
    ),
  ],
);

export type PlanEntitlementRow = typeof planEntitlement.$inferSelect;

/**
 * Where the authorization to charge the owner stands at the provider, as the provider last
 * confirmed it: `none` (nobody started), `pending` (a checkout exists and waits for the payer),
 * `authorized`, `lost` (the provider says the authorization was cancelled or paused).
 */
export const AUTHORIZATION_STATES = ['none', 'pending', 'authorized', 'lost'] as const;
export type AuthorizationState = (typeof AUTHORIZATION_STATES)[number];

/** Why a subscription is parked for a person. */
export const ATTENTION_REASONS = [
  'ambiguous_preapproval',
  'identity_mismatch',
  'unexpected_state',
  'reauthorization_needed',
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

/**
 * The subscription of an organization (one row per organization). Every organization that is not
 * exempt has exactly one; an exempt one (a demo, a deployment without billing) has none, and a
 * trigger refuses to insert it. The state moves only along the transition table of the module
 * (`domain/subscription-state.ts`), which a trigger repeats as a backstop, and only because the
 * provider confirmed something or a date arrived: never because a confirmation is missing.
 *
 * Money and card data: the row holds the LABEL the provider gives to the payment method ("Visa
 * terminada en 4242"). It never holds a card number.
 */
export const subscription = tenantTable(
  'subscription',
  {
    planId: uuid('plan_id').notNull(),
    status: text('status').notNull().default('trial'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }).notNull(),
    graceEndsAt: timestamp('grace_ends_at', { withTimezone: true }),
    /** The end of the last period a payment covered; a cancelling subscription ends here. */
    paidThrough: timestamp('paid_through', { withTimezone: true }),
    /** How many of the dunning notices (day 1, 3, 5 after the first failure) were done. */
    dunningStep: smallint('dunning_step').notNull().default(0),
    /** The most extra WhatsApp messages a period may bill; 0 turns overage off. Never unlimited. */
    overageCapMessages: integer('overage_cap_messages').notNull(),
    authorizationState: text('authorization_state').notNull().default('none'),
    /** The preapproval of the provider this subscription charges through (the current one). */
    providerPreapprovalId: text('provider_preapproval_id'),
    /** The reference of that preapproval, derived by the server. */
    externalReference: text('external_reference'),
    /** The label the provider gives to the payment method. Never a card number. */
    paymentMethodLabel: text('payment_method_label'),
    /** The monthly amount the owner authorized with the provider, in cents. */
    authorizedAmountCents: bigint('authorized_amount_cents', { mode: 'number' }),
    /** When the provider says it charges next. */
    nextChargeAt: timestamp('next_charge_at', { withTimezone: true }),
    /** When a charge first failed: the grace and the dunning count from here. */
    firstFailureAt: timestamp('first_failure_at', { withTimezone: true }),
    /** When the owner asked to cancel. */
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    /**
     * Why the subscription is parked for a person: the provider holds something the platform cannot
     * tell apart (several preapprovals under one reference), or something that is not what was asked.
     * Nothing more is sent to the provider for it until somebody decides. Null when nothing is parked.
     */
    attentionReason: text('attention_reason'),
    attentionAt: timestamp('attention_at', { withTimezone: true }),
    /** The last time the provider was asked where everything stands and answered. */
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'subscription_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'subscription_plan_fkey',
      columns: [table.planId],
      foreignColumns: [plan.id],
    }),
    unique('subscription_tenant_key').on(table.tenantId),
    check('subscription_status_check', sql`${table.status} in (${list(SUBSCRIPTION_STATUSES)})`),
    check(
      'subscription_authorization_check',
      sql`${table.authorizationState} in (${list(AUTHORIZATION_STATES)})`,
    ),
    check('subscription_dunning_step_check', sql`${table.dunningStep} between 0 and 3`),
    check('subscription_overage_cap_check', sql`${table.overageCapMessages} >= 0`),
    check('subscription_version_check', sql`${table.version} >= 1`),
    // The grace is what makes a subscription past due or read-only: one without it is not either.
    check(
      'subscription_grace_check',
      sql`${table.status} not in ('past_due', 'read_only') or ${table.graceEndsAt} is not null`,
    ),
    // A preapproval is known by its reference, and the reference by its preapproval.
    check(
      'subscription_preapproval_check',
      sql`${table.providerPreapprovalId} is null or ${table.externalReference} is not null`,
    ),
    check(
      'subscription_attention_check',
      sql`${table.attentionReason} is null or ${table.attentionReason} in (${list(ATTENTION_REASONS)})`,
    ),
    check(
      'subscription_attention_at_check',
      sql`(${table.attentionReason} is null) = (${table.attentionAt} is null)`,
    ),
    uniqueIndex('subscription_preapproval_key')
      .on(table.providerPreapprovalId)
      .where(sql`${table.providerPreapprovalId} is not null`),
    index('subscription_status_idx').on(table.status),
  ],
);

export type SubscriptionRow = typeof subscription.$inferSelect;
export type NewSubscriptionRow = typeof subscription.$inferInsert;

/** What a usage record meters. */
export const USAGE_KINDS = ['active_professional_day', 'whatsapp_messages'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * What the subscription meters (subscriptions, "Per-active-professional pricing", "WhatsApp quota"):
 * `active_professional_day` is one row per professional and billing day on which the professional was
 * active (written by the daily snapshot, once per day however many times it runs), and
 * `whatsapp_messages` is the count of messages the provider accepted for a professional in a period
 * (rewritten by the snapshot from `whatsapp_usage_event`, which stays the source of the count).
 * Counts only: no patient, no message.
 */
export const usageRecord = tenantTable(
  'usage_record',
  {
    kind: text('kind').notNull(),
    professionalId: uuid('professional_id').notNull(),
    /** The billing period (`YYYY-MM`). */
    period: text('period').notNull(),
    /** The billing day (`YYYY-MM-DD`) of an `active_professional_day`; null for the monthly count. */
    day: text('day'),
    quantity: integer('quantity').notNull().default(1),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'usage_record_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'usage_record_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    check('usage_record_kind_check', sql`${table.kind} in (${list(USAGE_KINDS)})`),
    check('usage_record_period_check', sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check('usage_record_quantity_check', sql`${table.quantity} >= 0`),
    // A day belongs to a day record and to nothing else, and it lies in the period it is filed under.
    check(
      'usage_record_day_check',
      sql`(${table.kind} = 'active_professional_day') = (${table.day} is not null) and (${table.day} is null or left(${table.day}, 7) = ${table.period})`,
    ),
    uniqueIndex('usage_record_day_key')
      .on(table.tenantId, table.professionalId, table.day)
      .where(sql`${table.kind} = 'active_professional_day'`),
    uniqueIndex('usage_record_month_key')
      .on(table.tenantId, table.professionalId, table.period)
      .where(sql`${table.kind} = 'whatsapp_messages'`),
    index('usage_record_period_idx').on(table.tenantId, table.period, table.kind),
  ],
);

export type UsageRecordRow = typeof usageRecord.$inferSelect;

/**
 * One line of a statement, as it is stored (the shape of `StatementLine` in
 * `modules/subscriptions/domain/statement.ts`, which produces it).
 */
export type StatementLineRecord =
  | {
      kind: 'professional';
      professionalId: string;
      name: string | null;
      days: number;
      daysInPeriod: number;
      amountCents: number;
    }
  | {
      kind: 'overage';
      professionalId: string;
      name: string | null;
      quota: number;
      used: number;
      units: number;
      unitPriceCents: number;
      amountCents: number;
      eventIds: readonly string[];
    };

/**
 * The statement of a billing period (subscriptions, "Billing cycle and statements"): what the
 * organization is billed for a period that closed, published to the owner BEFORE anything is
 * collected. It is written once, at the close of the period, and its figures never change afterwards
 * (a trigger refuses it); what moves is only `collected_cents`, up to the total and never down, and the
 * bookkeeping of the email.
 *
 * `collect_after` is at least three days after `published_at`, enforced here and not only in the
 * code: the invariant "nothing is collected without a statement the owner could see" does not depend
 * on the payments provider or on a job being correct.
 */
export const statement = tenantTable(
  'statement',
  {
    subscriptionId: uuid('subscription_id').notNull(),
    /** The billing period (`YYYY-MM`) the statement closes. */
    period: text('period').notNull(),
    planId: uuid('plan_id').notNull(),
    professionalsCounted: integer('professionals_counted').notNull(),
    baseCents: bigint('base_cents', { mode: 'number' }).notNull(),
    overageUnits: integer('overage_units').notNull().default(0),
    overageCents: bigint('overage_cents', { mode: 'number' }).notNull().default(0),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    /** The cap of overage messages that applied to the period. */
    overageCapMessages: integer('overage_cap_messages').notNull(),
    lines: jsonb('lines').$type<StatementLineRecord[]>().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    collectAfter: timestamp('collect_after', { withTimezone: true }).notNull(),
    collectedCents: bigint('collected_cents', { mode: 'number' }).notNull().default(0),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'statement_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'statement_subscription_fkey',
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [subscription.tenantId, subscription.id],
    }),
    unique('statement_period_key').on(table.subscriptionId, table.period),
    check('statement_period_check', sql`${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check(
      'statement_amounts_check',
      sql`${table.baseCents} >= 0 and ${table.overageCents} >= 0 and ${table.overageUnits} >= 0 and ${table.professionalsCounted} >= 1 and ${table.totalCents} = ${table.baseCents} + ${table.overageCents}`,
    ),
    check(
      'statement_collected_check',
      sql`${table.collectedCents} >= 0 and ${table.collectedCents} <= ${table.totalCents}`,
    ),
    // The window the owner has to see the statement before anything is collected.
    check(
      'statement_window_check',
      sql`${table.collectAfter} >= ${table.publishedAt} + interval '3 days'`,
    ),
    index('statement_open_idx')
      .on(table.subscriptionId, table.period)
      .where(sql`${table.collectedCents} < ${table.totalCents}`),
  ],
);

export type StatementRow = typeof statement.$inferSelect;

/**
 * One notice of the provider that was accepted (`POST /webhooks/mercadopago`). The id the provider
 * gave the delivery is UNIQUE: the same notice delivered twice finds its row and does nothing. The id is
 * derived from what the provider SIGNED (the request id, the resource and the time), never from the
 * unsigned body, so a replay cannot take the id of a delivery that has not arrived yet. The
 * row says that something was ASKED about (a resource), never what the state is; the state is
 * whatever the provider answers when the reconcile job asks.
 */
export const subscriptionEvent = tenantTable(
  'subscription_event',
  {
    eventId: text('event_id').notNull(),
    topic: text('topic').notNull(),
    resourceId: text('resource_id').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'subscription_event_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    unique('subscription_event_event_id_key').on(table.eventId),
    check(
      'subscription_event_topic_check',
      sql`${table.topic} in ('preapproval', 'payment', 'authorized_payment')`,
    ),
    index('subscription_event_resource_idx').on(table.tenantId, table.resourceId),
    // The purge of the old ones (`app.subscription_event_purge`) reads by organization and age.
    index('subscription_event_received_idx').on(table.tenantId, table.receivedAt),
  ],
);

export type SubscriptionEventRow = typeof subscriptionEvent.$inferSelect;

/** What a write to the provider is for. */
export const ATTEMPT_KINDS = [
  'preapproval',
  'amount_change',
  'payment_link',
  'refund',
  'cancel',
] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

/**
 * Where a write to the provider stands. `marked`: the intent was written BEFORE the call and the
 * request may be in flight, or its outcome is not known; `confirmed`: the provider's answer is
 * recorded; `rejected`: the provider refused for good; `released`: the provider provably holds
 * nothing (it said the request never reached it, or it holds nothing after the settle window), so a
 * new one may be sent; `parked`: more than one resource could be ours, or one is not what was asked,
 * and a person decides.
 */
export const ATTEMPT_STATES = ['marked', 'confirmed', 'rejected', 'released', 'parked'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

/**
 * The write-ahead log of the payments provider (subscriptions, payment safety). Every write to the
 * provider (a preapproval, a change of amount, a payment link, a refund, a cancellation) first writes
 * a row here, in a short transaction of its own that commits BEFORE the call; the answer is written
 * in another one after it. The provider may not honour the idempotency key, and a request the caller
 * gave up on may still land, so the row is what makes every later step safe: it holds the reference
 * the server derived, the key, what was asked and when it was sent, and `settle_until`, the instant
 * before which nothing is sent again, adopted or released.
 *
 * At most one write of a kind is open (`marked` or `parked`) for a subscription at a time (and, for a
 * refund, for a payment): that is the lock that no database lock replaces, because none is held
 * while the provider answers.
 */
export const subscriptionAttempt = tenantTable(
  'subscription_attempt',
  {
    subscriptionId: uuid('subscription_id').notNull(),
    kind: text('kind').notNull(),
    /** Derived by the server from the subscription (or the statement) and the attempt. */
    externalReference: text('external_reference').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull().default(0),
    payerEmail: text('payer_email'),
    /** For a change of amount: the amount the preapproval held before. */
    previousAmountCents: bigint('previous_amount_cents', { mode: 'number' }),
    statementId: uuid('statement_id'),
    /** For a refund: the payment of the provider, and the refunds it had before the call. */
    paymentId: text('payment_id'),
    refundIdsBefore: jsonb('refund_ids_before').$type<string[]>(),
    state: text('state').notNull().default('marked'),
    /** The provider's id of what the write made (a preapproval, a link, a refund). */
    resourceId: text('resource_id'),
    /** Where the payer goes to authorize or pay. */
    resourceUrl: text('resource_url'),
    /** The request was sent and its outcome is not known. */
    outcomeUnknown: boolean('outcome_unknown').notNull().default(false),
    message: text('message'),
    /** The instant the request was sent (written before the call). */
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull(),
    /** Before this instant a request that was given up on may still land. */
    settleUntil: timestamp('settle_until', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'subscription_attempt_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'subscription_attempt_subscription_fkey',
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [subscription.tenantId, subscription.id],
    }),
    foreignKey({
      name: 'subscription_attempt_statement_fkey',
      columns: [table.tenantId, table.statementId],
      foreignColumns: [statement.tenantId, statement.id],
    }),
    check('subscription_attempt_kind_check', sql`${table.kind} in (${list(ATTEMPT_KINDS)})`),
    check('subscription_attempt_state_check', sql`${table.state} in (${list(ATTEMPT_STATES)})`),
    check('subscription_attempt_amount_check', sql`${table.amountCents} >= 0`),
    check(
      'subscription_attempt_resolved_check',
      sql`(${table.state} in ('marked', 'parked')) = (${table.resolvedAt} is null)`,
    ),
    uniqueIndex('subscription_attempt_key').on(table.idempotencyKey),
    index('subscription_attempt_reference_idx').on(table.externalReference),
    // At most one open write of a kind for a subscription (a refund: for a payment).
    uniqueIndex('subscription_attempt_open_key')
      .on(table.subscriptionId, table.kind, sql`coalesce(${table.paymentId}, '')`)
      .where(sql`${table.state} in ('marked', 'parked')`),
  ],
);

export type SubscriptionAttemptRow = typeof subscriptionAttempt.$inferSelect;

/** The statuses a payment of the provider can be in. */
const PAYMENT_ROW_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'cancelled',
  'refunded',
  'partially_refunded',
  'charged_back',
] as const;

/**
 * A payment the provider confirmed for the subscription (the monthly charge, or a one-off link),
 * recorded once by the id the provider gave it. It holds amounts and never a card. A billing period
 * is paid once: the first approved payment of a period credits it; a second one is a SURPLUS,
 * flagged for the platform operator (`surplus`), and moves nothing.
 */
export const subscriptionPayment = tenantTable(
  'subscription_payment',
  {
    subscriptionId: uuid('subscription_id').notNull(),
    providerPaymentId: text('provider_payment_id').notNull(),
    purpose: text('purpose').notNull(),
    reference: text('reference').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    status: text('status').notNull(),
    refundedCents: bigint('refunded_cents', { mode: 'number' }).notNull().default(0),
    /** The period this payment credited (`YYYY-MM`); null when it credited none. */
    period: text('period'),
    surplus: boolean('surplus').notNull().default(false),
    /** The operator looked at the surplus. */
    surplusReviewedAt: timestamp('surplus_reviewed_at', { withTimezone: true }),
    /** The approval was credited to the subscription (or flagged as a surplus). */
    credited: boolean('credited').notNull().default(false),
    statementId: uuid('statement_id'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'subscription_payment_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'subscription_payment_subscription_fkey',
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [subscription.tenantId, subscription.id],
    }),
    foreignKey({
      name: 'subscription_payment_statement_fkey',
      columns: [table.tenantId, table.statementId],
      foreignColumns: [statement.tenantId, statement.id],
    }),
    unique('subscription_payment_provider_key').on(table.tenantId, table.providerPaymentId),
    check(
      'subscription_payment_purpose_check',
      sql`${table.purpose} in ('charge', 'overdue', 'statement')`,
    ),
    check(
      'subscription_payment_status_check',
      sql`${table.status} in (${list(PAYMENT_ROW_STATUSES)})`,
    ),
    check('subscription_payment_amount_check', sql`${table.amountCents} > 0`),
    check(
      'subscription_payment_refunded_check',
      sql`${table.refundedCents} >= 0 and ${table.refundedCents} <= ${table.amountCents}`,
    ),
    check(
      'subscription_payment_period_check',
      sql`${table.period} is null or ${table.period} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
    check('subscription_payment_surplus_check', sql`not ${table.surplus} or ${table.credited}`),
    index('subscription_payment_subscription_idx').on(
      table.subscriptionId,
      table.providerCreatedAt,
    ),
    index('subscription_payment_surplus_idx')
      .on(table.tenantId)
      .where(sql`${table.surplus} and ${table.surplusReviewedAt} is null`),
  ],
);

export type SubscriptionPaymentRow = typeof subscriptionPayment.$inferSelect;

/**
 * A refund of a payment, recorded as an entry of its own (subscriptions, "Duplicate payment protection
 * and refunds"): the payment keeps what it was, and the refund says how much went back, when, and who
 * asked. Written when the provider confirms it, whoever made it.
 */
export const subscriptionRefund = tenantTable(
  'subscription_refund',
  {
    paymentId: uuid('payment_id').notNull(),
    providerRefundId: text('provider_refund_id').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** `operator` when the platform operator asked for it, `provider` when the provider reports one. */
    source: text('source').notNull(),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'subscription_refund_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'subscription_refund_payment_fkey',
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [subscriptionPayment.tenantId, subscriptionPayment.id],
    }),
    unique('subscription_refund_provider_key').on(table.tenantId, table.providerRefundId),
    check('subscription_refund_amount_check', sql`${table.amountCents} > 0`),
    check('subscription_refund_source_check', sql`${table.source} in ('operator', 'provider')`),
  ],
);

export type SubscriptionRefundRow = typeof subscriptionRefund.$inferSelect;

/** What the owner is told about the subscription, by email, once each. */
export const NOTICE_KINDS = [
  'past_due_started',
  'dunning_1',
  'dunning_3',
  'dunning_5',
  'read_only_started',
  'recovered',
  /** A statement was published; the key is its id. */
  'statement_published',
  /** The provider would not change the recurring amount: the difference is asked by a link. */
  'amount_change_refused',
  /** The provider wants the owner to authorize the new amount again. */
  'reauthorization_needed',
  /** The overage cap of the period was reached: WhatsApp messages go by email. The key is the period. */
  'overage_cap_reached',
] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

/**
 * A notice to the owner (subscriptions, "Failed payment and dunning"). The row IS the "already told":
 * the unique key on the kind and the moment it is about (the grace it announces, the failure it
 * follows) makes a second notice for the same thing impossible, however many times a job runs. It is
 * written in the transaction that changed the state, and the email is sent after that commits:
 * `sent_at` stays empty until the mail server accepted it, and a claim (`last_attempt_at`) keeps two
 * workers from sending the same one at the same time. Nothing here names a patient.
 */
export const subscriptionNotice = tenantTable(
  'subscription_notice',
  {
    subscriptionId: uuid('subscription_id').notNull(),
    kind: text('kind').notNull(),
    /** The moment the notice is about, as text: the end of the grace, the date of the failure. */
    key: text('key').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'subscription_notice_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'subscription_notice_subscription_fkey',
      columns: [table.tenantId, table.subscriptionId],
      foreignColumns: [subscription.tenantId, subscription.id],
    }),
    unique('subscription_notice_key').on(table.subscriptionId, table.kind, table.key),
    check('subscription_notice_kind_check', sql`${table.kind} in (${list(NOTICE_KINDS)})`),
    check('subscription_notice_attempts_check', sql`${table.attempts} >= 0`),
    index('subscription_notice_unsent_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`${table.sentAt} is null`),
  ],
);

export type SubscriptionNoticeRow = typeof subscriptionNotice.$inferSelect;

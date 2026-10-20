import { SUBSCRIPTION_STATUSES } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
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
    uniqueIndex('subscription_preapproval_key')
      .on(table.providerPreapprovalId)
      .where(sql`${table.providerPreapprovalId} is not null`),
    index('subscription_status_idx').on(table.status),
  ],
);

export type SubscriptionRow = typeof subscription.$inferSelect;
export type NewSubscriptionRow = typeof subscription.$inferInsert;

/**
 * One notice of the provider that was accepted (`POST /webhooks/mercadopago`). The id the provider
 * gave the delivery is UNIQUE: the same notice delivered twice finds its row and does nothing. The
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
  ],
);

export type SubscriptionEventRow = typeof subscriptionEvent.$inferSelect;

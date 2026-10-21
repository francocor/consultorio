import { PAYMENTS_SIMULATOR_MODES } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * Platform tables of the local Mercado Pago simulator (`PAYMENTS_PROVIDER=local`). They have no
 * `tenant_id` and no row level security on purpose: the simulator stands in for Mercado Pago, which
 * is outside every organization and tells their resources apart by the reference the server derives
 * from the organization and the subscription. They are never read in production (the guard refuses
 * the simulator there). The API and the worker share them through Postgres.
 *
 * The simulator keeps no card, no patient and no name: a preapproval is the reference it was asked
 * to carry, the payer's address, an amount and the state the payer put it in on the hosted page.
 * Nothing is deleted: a reset moves `local_mp_control.epoch` forward and every query looks at the
 * current epoch only.
 */

/** The one row of controls of the simulator. */
export const localMpControl = pgTable(
  'local_mp_control',
  {
    id: smallint('id').primaryKey().default(1),
    mode: text('mode').notNull().default('ok'),
    /** Moves forward on reset: the resources and requests of older epochs no longer exist for it. */
    epoch: integer('epoch').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('local_mp_control_single_row_check', sql`${table.id} = 1`),
    check('local_mp_control_mode_check', sql.raw(`"mode" in (${list(PAYMENTS_SIMULATOR_MODES)})`)),
  ],
);

/** An authorization to charge a payer every month, and the state the payer put it in. */
export const localMpPreapproval = pgTable(
  'local_mp_preapproval',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    /** The identifier the provider gives (`PRE-...`). */
    preapprovalId: text('preapproval_id').notNull(),
    externalReference: text('external_reference').notNull(),
    payerEmail: text('payer_email').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    /** The amount the payer was asked to authorize again; applied when they do. */
    pendingAmountCents: bigint('pending_amount_cents', { mode: 'number' }),
    currency: text('currency').notNull().default('ARS'),
    status: text('status').notNull().default('pending'),
    paymentMethodLabel: text('payment_method_label'),
    nextChargeAt: timestamp('next_charge_at', { withTimezone: true }),
    backUrl: text('back_url').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      'local_mp_preapproval_status_check',
      sql.raw(`"status" in ('pending', 'authorized', 'paused', 'cancelled')`),
    ),
    check('local_mp_preapproval_amount_check', sql`${table.amountCents} > 0`),
    uniqueIndex('local_mp_preapproval_id_key').on(table.epoch, table.preapprovalId),
    index('local_mp_preapproval_reference_idx').on(table.epoch, table.externalReference),
  ],
);

/** A one-off payment link. */
export const localMpLink = pgTable(
  'local_mp_link',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    linkId: text('link_id').notNull(),
    externalReference: text('external_reference').notNull(),
    payerEmail: text('payer_email').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('ARS'),
    title: text('title').notNull(),
    backUrl: text('back_url').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('local_mp_link_amount_check', sql`${table.amountCents} > 0`),
    uniqueIndex('local_mp_link_id_key').on(table.epoch, table.linkId),
    index('local_mp_link_reference_idx').on(table.epoch, table.externalReference),
  ],
);

/** A payment: the charge of a cycle of a preapproval, or the payment of a link. Refunds are listed. */
export const localMpPayment = pgTable(
  'local_mp_payment',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    paymentId: text('payment_id').notNull(),
    externalReference: text('external_reference').notNull(),
    preapprovalId: text('preapproval_id'),
    linkId: text('link_id'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('ARS'),
    status: text('status').notNull(),
    refundedCents: bigint('refunded_cents', { mode: 'number' }).notNull().default(0),
    refunds: jsonb('refunds')
      .$type<{ refundId: string; amountCents: number; createdAt: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      'local_mp_payment_status_check',
      sql.raw(
        `"status" in ('pending', 'approved', 'rejected', 'cancelled', 'refunded', 'partially_refunded', 'charged_back')`,
      ),
    ),
    check('local_mp_payment_amount_check', sql`${table.amountCents} > 0`),
    check(
      'local_mp_payment_refunded_check',
      sql`${table.refundedCents} >= 0 and ${table.refundedCents} <= ${table.amountCents}`,
    ),
    check(
      'local_mp_payment_origin_check',
      sql`(${table.preapprovalId} is null) <> (${table.linkId} is null)`,
    ),
    uniqueIndex('local_mp_payment_id_key').on(table.epoch, table.paymentId),
    index('local_mp_payment_preapproval_idx').on(table.epoch, table.preapprovalId),
    index('local_mp_payment_reference_idx').on(table.epoch, table.externalReference),
  ],
);

/**
 * The answer given to each idempotency key, consulted only when the simulator is told to honour the
 * key (`honoursIdempotencyKey`). The fingerprint is a digest of what was asked: a key that comes back
 * with another request is refused.
 */
export const localMpRequest = pgTable(
  'local_mp_request',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    fingerprint: text('fingerprint').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('local_mp_request_key').on(table.epoch, table.idempotencyKey)],
);

export type LocalMpPreapprovalRow = typeof localMpPreapproval.$inferSelect;
export type LocalMpLinkRow = typeof localMpLink.$inferSelect;
export type LocalMpPaymentRow = typeof localMpPayment.$inferSelect;

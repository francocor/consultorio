import {
  CASH_SESSION_STATUSES,
  EXPORT_FORMATS,
  EXPORT_KINDS,
  EXPORT_STATUSES,
  PAYMENT_METHODS,
  PAYMENT_REVERSAL_KINDS,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { charge } from './billing-charges.js';
import { location, tenant } from './tenant.js';

// Payment, refund and cash register tables of the billing module, track A (S4.03), and the table
// that follows the exports (S4.05; it lives in this migration because the track has three numbers).
// Every amount is a whole number of cents of ARS. No column can hold a card number.

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** A reference (a voucher or a transfer number) that is only a card number is refused. */
const NOT_A_CARD_NUMBER = String.raw`"external_ref" is null or "external_ref" !~ '^(\d[ -]?){12,18}\d$'`;

/**
 * The cash register of a location for a day (billing-payments, "Daily cash register per location").
 * At most one is open per location. Closing writes what was expected (the opening cash plus the
 * cash taken, minus the cash given back), what was counted, and the difference with its reason; a
 * closed register and the entries in it never change (a trigger refuses it), and a correction
 * is made as new entries in the register that is open.
 */
export const cashSession = tenantTable(
  'cash_session',
  {
    locationId: uuid('location_id').notNull(),
    status: text('status').notNull().default('open'),
    openedBy: uuid('opened_by').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    openingCents: bigint('opening_cents', { mode: 'number' }).notNull(),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    expectedCents: bigint('expected_cents', { mode: 'number' }),
    countedCents: bigint('counted_cents', { mode: 'number' }),
    /** Counted minus expected: negative when cash is missing. */
    differenceCents: bigint('difference_cents', { mode: 'number' }),
    differenceReason: text('difference_reason'),
  },
  (table) => [
    foreignKey({
      name: 'cash_session_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'cash_session_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('cash_session_status_check', sql.raw(`"status" in (${list(CASH_SESSION_STATUSES)})`)),
    check('cash_session_opening_check', sql`${table.openingCents} >= 0`),
    check(
      'cash_session_close_check',
      sql`(${table.status} = 'closed') = (${table.closedAt} is not null)
        and (${table.status} = 'closed') = (${table.closedBy} is not null)
        and (${table.status} = 'closed') = (${table.expectedCents} is not null)
        and (${table.status} = 'closed') = (${table.countedCents} is not null)
        and (${table.status} = 'closed') = (${table.differenceCents} is not null)`,
    ),
    check(
      'cash_session_difference_check',
      sql`${table.status} = 'open'
        or (${table.countedCents} >= 0
            and ${table.differenceCents} = ${table.countedCents} - ${table.expectedCents}
            and (${table.differenceCents} = 0
                 or length(btrim(coalesce(${table.differenceReason}, ''))) >= 3))`,
    ),
    // One open register per location.
    uniqueIndex('cash_session_open_key')
      .on(table.tenantId, table.locationId)
      .where(sql`${table.status} = 'open'`),
    index('cash_session_location_idx').on(table.tenantId, table.locationId, table.openedAt),
  ],
);

export type CashSessionRow = typeof cashSession.$inferSelect;

/**
 * Money received for a charge (billing-payments, "Payment recording"). Append-only: a payment is
 * never edited or deleted, and a refund or a correction is a `payment_reversal`.
 *
 * - `idempotency_key` is chosen by the client for each submission; a retry of the same submission
 *   finds the payment instead of making another. `request_hash` tells a retry from a different
 *   request that reused the key.
 * - `external_ref` is a voucher or transfer number. The same one is refused twice, unless the second
 *   payment carries an `override_reason` (audited).
 * - `credit_cents` is the part above what the patient owed that a person confirmed as a credit.
 * - Cash goes into the open register of the location; a payment by another method joins the open
 *   register for the daily summary, when there is one.
 * - `corrects_payment_id` links the new entry of a correction to the one it replaces.
 */
export const payment = tenantTable(
  'payment',
  {
    chargeId: uuid('charge_id').notNull(),
    locationId: uuid('location_id').notNull(),
    cashSessionId: uuid('cash_session_id'),
    method: text('method').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    creditCents: bigint('credit_cents', { mode: 'number' }).notNull().default(0),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid('recorded_by').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    externalRef: text('external_ref'),
    overrideReason: text('override_reason'),
    correctsPaymentId: uuid('corrects_payment_id'),
  },
  (table) => [
    foreignKey({
      name: 'payment_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'payment_charge_fkey',
      columns: [table.tenantId, table.chargeId],
      foreignColumns: [charge.tenantId, charge.id],
    }),
    foreignKey({
      name: 'payment_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: 'payment_cash_session_fkey',
      columns: [table.tenantId, table.cashSessionId],
      foreignColumns: [cashSession.tenantId, cashSession.id],
    }),
    foreignKey({
      name: 'payment_corrects_fkey',
      columns: [table.tenantId, table.correctsPaymentId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check('payment_method_check', sql.raw(`"method" in (${list(PAYMENT_METHODS)})`)),
    check('payment_amount_check', sql`${table.amountCents} > 0`),
    check(
      'payment_credit_check',
      sql`${table.creditCents} >= 0 and ${table.creditCents} <= ${table.amountCents}`,
    ),
    check(
      'payment_cash_register_check',
      sql`${table.method} <> 'cash' or ${table.cashSessionId} is not null`,
    ),
    check('payment_idempotency_check', sql`length(${table.idempotencyKey}) between 8 and 128`),
    check('payment_reference_check', sql.raw(NOT_A_CARD_NUMBER)),
    check(
      'payment_reference_length_check',
      sql`${table.externalRef} is null or length(btrim(${table.externalRef})) between 1 and 64`,
    ),
    check(
      'payment_override_check',
      sql`${table.overrideReason} is null or length(btrim(${table.overrideReason})) >= 3`,
    ),
    uniqueIndex('payment_idempotency_key').on(table.tenantId, table.idempotencyKey),
    // The same voucher once, unless a person gave a reason for repeating it.
    uniqueIndex('payment_reference_key')
      .on(table.tenantId, table.externalRef)
      .where(sql`${table.externalRef} is not null and ${table.overrideReason} is null`),
    index('payment_charge_idx').on(table.tenantId, table.chargeId, table.createdAt),
    index('payment_session_idx')
      .on(table.tenantId, table.cashSessionId)
      .where(sql`${table.cashSessionId} is not null`),
    index('payment_location_idx').on(table.tenantId, table.locationId, table.paidAt),
  ],
);

export type PaymentRow = typeof payment.$inferSelect;

/**
 * A refund or a correction: money given back for a payment (billing-payments, "Refunds and payment
 * reversals"). Append-only and linked to the payment; the sum of its reversals never exceeds the
 * payment. A reversal of cash leaves the open register of the place, so a correction after the
 * register closed changes only the register that is open.
 */
export const paymentReversal = tenantTable(
  'payment_reversal',
  {
    paymentId: uuid('payment_id').notNull(),
    chargeId: uuid('charge_id').notNull(),
    locationId: uuid('location_id').notNull(),
    cashSessionId: uuid('cash_session_id'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    kind: text('kind').notNull(),
    reversedBy: uuid('reversed_by').notNull(),
    reversedAt: timestamp('reversed_at', { withTimezone: true }).notNull().defaultNow(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'payment_reversal_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'payment_reversal_payment_fkey',
      columns: [table.tenantId, table.paymentId],
      foreignColumns: [payment.tenantId, payment.id],
    }),
    foreignKey({
      name: 'payment_reversal_charge_fkey',
      columns: [table.tenantId, table.chargeId],
      foreignColumns: [charge.tenantId, charge.id],
    }),
    foreignKey({
      name: 'payment_reversal_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: 'payment_reversal_cash_session_fkey',
      columns: [table.tenantId, table.cashSessionId],
      foreignColumns: [cashSession.tenantId, cashSession.id],
    }),
    check('payment_reversal_amount_check', sql`${table.amountCents} > 0`),
    check('payment_reversal_reason_check', sql`length(btrim(${table.reason})) between 3 and 200`),
    check('payment_reversal_kind_check', sql.raw(`"kind" in (${list(PAYMENT_REVERSAL_KINDS)})`)),
    check(
      'payment_reversal_idempotency_check',
      sql`length(${table.idempotencyKey}) between 8 and 128`,
    ),
    uniqueIndex('payment_reversal_idempotency_key').on(table.tenantId, table.idempotencyKey),
    index('payment_reversal_payment_idx').on(table.tenantId, table.paymentId),
    index('payment_reversal_charge_idx').on(table.tenantId, table.chargeId),
    index('payment_reversal_session_idx')
      .on(table.tenantId, table.cashSessionId)
      .where(sql`${table.cashSessionId} is not null`),
  ],
);

export type PaymentReversalRow = typeof paymentReversal.$inferSelect;

/**
 * An export someone asked for (billing-payments, "Exports"): what, in which format, with which
 * filters, and where it stands. The file is made by the `export.build` job and stored at
 * `object_key`; a request with nothing to list ends `empty` and makes no file. Never deleted.
 */
export const exportRequest = tenantTable(
  'export_request',
  {
    kind: text('kind').notNull(),
    format: text('format').notNull(),
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('queued'),
    requestedBy: uuid('requested_by').notNull(),
    objectKey: text('object_key'),
    fileName: text('file_name'),
    sizeBytes: integer('size_bytes'),
    rowCount: integer('row_count'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureCode: text('failure_code'),
  },
  (table) => [
    foreignKey({
      name: 'export_request_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    check('export_request_kind_check', sql.raw(`"kind" in (${list(EXPORT_KINDS)})`)),
    check('export_request_format_check', sql.raw(`"format" in (${list(EXPORT_FORMATS)})`)),
    check('export_request_status_check', sql.raw(`"status" in (${list(EXPORT_STATUSES)})`)),
    check(
      'export_request_file_check',
      sql`(${table.status} = 'ready') = (${table.objectKey} is not null)`,
    ),
    index('export_request_requester_idx').on(table.tenantId, table.requestedBy, table.createdAt),
  ],
);

export type ExportRequestRow = typeof exportRequest.$inferSelect;

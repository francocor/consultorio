import {
  CHARGE_LINE_KINDS,
  CHARGE_LINE_PORTIONS,
  CHARGE_REVIEW_REASONS,
  CHARGE_STATUSES,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { tenantPayer } from './billing-pricing.js';
import { patient } from './patients.js';
import { appointment } from './scheduling.js';
import { professional } from './staff.js';
import { location, tenant } from './tenant.js';

// Charge tables of the billing module (charge, charge_line), track A (S4.02). Every amount is a
// whole number of cents of ARS.

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** The figures of a quote that the charge applied, as the quote shows them (`QuoteDto` + names). */
export type ChargeSnapshot = Record<string, unknown>;

/**
 * What is owed for one appointment (billing-payments, "Charge capture per appointment"). It is made
 * of charge lines, says who owes what (the patient, the payer), and keeps a copy of the figures it
 * applied (`snapshot`): changing a price afterwards never changes a charge.
 *
 * - One charge that is not voided per appointment. A voided charge stays, with its reason, and the
 *   appointment can be charged again.
 * - `status` follows the payments and refunds of the patient portion; the application derives it in
 *   the transaction that records them. `voided` is final.
 * - A charge made when nothing priced the service carries `explicit_amount`: a person typed the
 *   amount, and the capture was audited as an override.
 * - `needs_review` flags a charge whose appointment became a no-show or was cancelled. Nothing is
 *   voided or refunded for it automatically.
 * - Whether and how much of it has been invoiced is derived from the lines; it is not a status.
 */
export const charge = tenantTable(
  'charge',
  {
    appointmentId: uuid('appointment_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    professionalId: uuid('professional_id').notNull(),
    locationId: uuid('location_id').notNull(),
    /** The payer the charge was made for; null for a private patient. */
    tenantPayerId: uuid('tenant_payer_id'),
    planName: text('plan_name'),
    status: text('status').notNull().default('pending'),
    snapshot: jsonb('snapshot').$type<ChargeSnapshot>().notNull(),
    explicitAmount: boolean('explicit_amount').notNull().default(false),
    needsReview: boolean('needs_review').notNull().default(false),
    reviewReason: text('review_reason'),
    flaggedAt: timestamp('flagged_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: uuid('voided_by'),
    capturedBy: uuid('captured_by').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'charge_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'charge_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    foreignKey({
      name: 'charge_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'charge_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'charge_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    foreignKey({
      name: 'charge_payer_fkey',
      columns: [table.tenantId, table.tenantPayerId],
      foreignColumns: [tenantPayer.tenantId, tenantPayer.id],
    }),
    check('charge_status_check', sql.raw(`"status" in (${list(CHARGE_STATUSES)})`)),
    check(
      'charge_void_check',
      sql`(${table.status} = 'voided') = (${table.voidReason} is not null)
        and (${table.status} = 'voided') = (${table.voidedAt} is not null)`,
    ),
    check(
      'charge_review_check',
      sql.raw(
        `("needs_review") = ("review_reason" is not null) and ("needs_review") = ("flagged_at" is not null) and ("review_reason" is null or "review_reason" in (${list(CHARGE_REVIEW_REASONS)}))`,
      ),
    ),
    // One charge in play per appointment; the voided ones stay as history.
    uniqueIndex('charge_appointment_key')
      .on(table.tenantId, table.appointmentId)
      .where(sql`${table.status} <> 'voided'`),
    index('charge_location_idx').on(table.tenantId, table.locationId, table.createdAt),
    index('charge_patient_idx').on(table.tenantId, table.patientId, table.createdAt),
    index('charge_professional_idx').on(table.tenantId, table.professionalId, table.createdAt),
    index('charge_review_idx')
      .on(table.tenantId, table.flaggedAt)
      .where(sql`${table.needsReview} and ${table.status} <> 'voided'`),
  ],
);

export type ChargeRow = typeof charge.$inferSelect;

/**
 * One line of a charge: a description, an amount, and whose it is (the patient or the payer). A
 * line is written once; only `invoiced_cents` moves afterwards (the invoices of the invoicing
 * module add to it, never above the amount of the line), so an invoice can cover lines of several
 * charges and a line can be invoiced in parts. The copago and the plus are lines of their own.
 */
export const chargeLine = tenantTable(
  'charge_line',
  {
    chargeId: uuid('charge_id').notNull(),
    position: smallint('position').notNull(),
    kind: text('kind').notNull(),
    portion: text('portion').notNull(),
    description: text('description').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    invoicedCents: bigint('invoiced_cents', { mode: 'number' }).notNull().default(0),
    createdBy: uuid('created_by'),
  },
  (table) => [
    foreignKey({
      name: 'charge_line_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'charge_line_charge_fkey',
      columns: [table.tenantId, table.chargeId],
      foreignColumns: [charge.tenantId, charge.id],
    }),
    check('charge_line_kind_check', sql.raw(`"kind" in (${list(CHARGE_LINE_KINDS)})`)),
    check('charge_line_portion_check', sql.raw(`"portion" in (${list(CHARGE_LINE_PORTIONS)})`)),
    check(
      'charge_line_description_check',
      sql`length(btrim(${table.description})) between 1 and 200`,
    ),
    check('charge_line_amount_check', sql`${table.amountCents} > 0`),
    check(
      'charge_line_invoiced_check',
      sql`${table.invoicedCents} >= 0 and ${table.invoicedCents} <= ${table.amountCents}`,
    ),
    uniqueIndex('charge_line_position_key').on(table.tenantId, table.chargeId, table.position),
  ],
);

export type ChargeLineRow = typeof chargeLine.$inferSelect;

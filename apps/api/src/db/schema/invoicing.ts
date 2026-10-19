import {
  FISCAL_ENVIRONMENTS,
  INVOICE_DELIVERY_STATES,
  INVOICE_STATUSES,
  INVOICE_TYPES,
  RECIPIENT_DOCUMENT_TYPES,
  RECIPIENT_TAX_CONDITIONS,
} from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { chargeLine } from './billing-charges.js';
import { tenantPayer } from './billing-pricing.js';
import { patient } from './patients.js';
import { tenant } from './tenant.js';

// Invoice tables of the invoicing module (invoice, invoice_line, invoice_document), track C
// (S4.10). Every amount is a whole number of cents of ARS. Migrations come from
// `pnpm db:new 4c <name>` (docs/migration-ranges.md).

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

const CREDIT_NOTE_TYPES = "'NCA', 'NCB', 'NCC'";

/**
 * Who issued the voucher, as the organization's fiscal profile said when the invoice was requested.
 * The profile can be edited later; the voucher (the request to the authority, its fingerprint and the
 * PDF) is always the one of this snapshot (JD-S4 R1-C7). `null` only on a manual voucher of an
 * organization with no fiscal profile.
 */
export interface IssuerSnapshot {
  cuit: string;
  businessName: string;
  taxCondition: string;
  address: string;
  activityStartedOn: string;
}

/**
 * An electronic invoice or a credit note, and every attempt at one (e-invoicing-afip). One row per
 * attempt: a rejected attempt stays, without a CAE, and a retry is a new row that points at it.
 *
 * - `status` is one of four. `delivery_state` is the internal sub-state of a PENDING invoice and
 *   exists only while it is pending; no screen shows it. A pending invoice that waited too long is
 *   flagged from its age, never given a state of its own.
 * - Only a pending invoice moves, and only its retry bookkeeping and its way out (issued or
 *   rejected). An issued invoice, a manual one and a rejected attempt are closed by a trigger.
 * - `number` and `cae` exist from the moment the authority (or the person who registers it by
 *   hand) gave them. The number is unique per point of sale and type.
 * - The recipient is a snapshot: it never follows later changes to the patient or the payer.
 * - A credit note (`NCA`, `NCB`, `NCC`) points at the invoice it cancels, with a reason. The sum of
 *   the notes of an invoice, pending ones included, never goes above the invoice.
 * - `location_ids` is a snapshot of the locations of the charges it covers: reception sees the
 *   invoices of its own locations without reading billing's tables.
 */
export const invoice = tenantTable(
  'invoice',
  {
    type: text('type').notNull(),
    /** The number of the point of sale, as AFIP knows it (a manual entry may name any). */
    pointOfSale: integer('point_of_sale').notNull(),
    /** Assigned by the authority; null until then. */
    number: bigint('number', { mode: 'number' }),
    status: text('status').notNull().default('pending'),
    deliveryState: text('delivery_state'),
    cae: text('cae'),
    caeExpiresOn: date('cae_expires_on', { mode: 'string' }),
    /** The date printed on the voucher, in the time zone of the organization. */
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    environment: text('environment').notNull(),
    /** True when a simulator (not the tax authority) is, or was, behind the voucher. */
    simulated: boolean('simulated').notNull().default(false),
    /** The key the client sent; the issuer receives it too, so a repeated request is one voucher. */
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    recipientKind: text('recipient_kind').notNull(),
    patientId: uuid('patient_id'),
    tenantPayerId: uuid('tenant_payer_id'),
    recipientName: text('recipient_name'),
    recipientTaxCondition: text('recipient_tax_condition').notNull(),
    recipientDocType: text('recipient_doc_type'),
    recipientDocNumber: text('recipient_doc_number'),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    netCents: bigint('net_cents', { mode: 'number' }).notNull(),
    vatCents: bigint('vat_cents', { mode: 'number' }).notNull().default(0),
    exemptCents: bigint('exempt_cents', { mode: 'number' }).notNull().default(0),
    locationIds: uuid('location_ids').array().notNull(),
    creditNoteOfId: uuid('credit_note_of_id'),
    reason: text('reason'),
    previousAttemptId: uuid('previous_attempt_id'),
    rejectionMessage: text('rejection_message'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** After an unknown outcome: the number the authority is expected to have given. */
    expectedNumber: bigint('expected_number', { mode: 'number' }),
    /**
     * When the invoice began to wait for reconciliation (its request may have been answered). Set by
     * the first mark of the episode, kept by the later attempts and cleared when the wait ends. A stalled
     * series is measured from here, not from the creation of the invoice or from the number of
     * attempts, which the probes that other invoices bring forward also count (JD-S4 R4-B-S1).
     */
    awaitingSince: timestamp('awaiting_since', { withTimezone: true }),
    /**
     * The last number the AUTHORITY had authorized in the series when the invoice was marked (its own
     * answer, not an inference from our rows). The voucher of a request that may have been answered is
     * above it, so reconciling looks at the numbers after it, up to the authority's last number now.
     * The first mark of a wait fixes it; the later marks keep it. Null for an invoice marked before the
     * column existed (JD-S4 R5-1).
     */
    authorityLastAtMark: bigint('authority_last_at_mark', { mode: 'number' }),
    /**
     * When the last request of the wait was sent: written by the mark, BEFORE the authority is called,
     * so a crash between the mark and the call leaves it set as if the request had gone. "Nothing was
     * issued for this invoice" is believed only after `SETTLE` has passed since then, because a request
     * the caller gave up on may still be being processed (JD-S4 R6-1). Cleared with the wait.
     */
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
    /**
     * How many times in a row the authority answered "no voucher" at a number at or below its own last
     * one. A lookup may lag behind an authorization for a moment, so the invoice waits for a few rounds
     * before it is parked for a person (JD-S4 R6-A-S1). Zero outside a wait.
     */
    lookupMisses: integer('lookup_misses').notNull().default(0),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    /** The issuer as the fiscal profile said at the time of the request; never changes. */
    issuerSnapshot: jsonb('issuer_snapshot').$type<IssuerSnapshot>(),
    createdBy: uuid('created_by').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'invoice_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'invoice_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'invoice_payer_fkey',
      columns: [table.tenantId, table.tenantPayerId],
      foreignColumns: [tenantPayer.tenantId, tenantPayer.id],
    }),
    foreignKey({
      name: 'invoice_credit_note_of_fkey',
      columns: [table.tenantId, table.creditNoteOfId],
      foreignColumns: [table.tenantId, table.id],
    }),
    foreignKey({
      name: 'invoice_previous_attempt_fkey',
      columns: [table.tenantId, table.previousAttemptId],
      foreignColumns: [table.tenantId, table.id],
    }),
    check('invoice_type_check', sql.raw(`"type" in (${list(INVOICE_TYPES)})`)),
    check('invoice_status_check', sql.raw(`"status" in (${list(INVOICE_STATUSES)})`)),
    check(
      'invoice_delivery_state_check',
      sql.raw(
        `("status" = 'pending') = ("delivery_state" is not null) and ("delivery_state" is null or "delivery_state" in (${list(INVOICE_DELIVERY_STATES)}))`,
      ),
    ),
    check('invoice_environment_check', sql.raw(`"environment" in (${list(FISCAL_ENVIRONMENTS)})`)),
    check('invoice_point_of_sale_check', sql`${table.pointOfSale} between 1 and 99999`),
    // The voucher data exists once the authority (or the person registering it) gave it.
    check(
      'invoice_voucher_check',
      sql.raw(
        `("status" in ('issued', 'manual')) = ("number" is not null) and ("status" in ('issued', 'manual')) = ("cae" is not null) and ("number" is null or "number" > 0) and ("cae" is null or "cae" ~ '^[0-9]{14}$') and ("status" <> 'issued' or "cae_expires_on" is not null) and ("status" in ('issued', 'manual') or ("cae_expires_on" is null and "issued_at" is null))`,
      ),
    ),
    check(
      'invoice_rejection_check',
      sql`(${table.status} = 'rejected') = (${table.rejectionMessage} is not null)`,
    ),
    check(
      'invoice_recipient_kind_check',
      sql`(${table.recipientKind} = 'patient' and ${table.patientId} is not null and ${table.tenantPayerId} is null)
        or (${table.recipientKind} = 'payer' and ${table.tenantPayerId} is not null and ${table.patientId} is null)`,
    ),
    check(
      'invoice_recipient_tax_condition_check',
      sql.raw(`"recipient_tax_condition" in (${list(RECIPIENT_TAX_CONDITIONS)})`),
    ),
    check(
      'invoice_recipient_document_check',
      sql.raw(
        `("recipient_doc_type" is null) = ("recipient_doc_number" is null) and ("recipient_doc_type" is null or "recipient_doc_type" in (${list(RECIPIENT_DOCUMENT_TYPES)}))`,
      ),
    ),
    check('invoice_total_check', sql`${table.totalCents} > 0`),
    check(
      'invoice_breakdown_check',
      sql`${table.netCents} >= 0 and ${table.vatCents} >= 0 and ${table.exemptCents} >= 0
        and ${table.netCents} + ${table.vatCents} + ${table.exemptCents} = ${table.totalCents}`,
    ),
    // A credit note cancels an invoice and says why.
    check(
      'invoice_credit_note_check',
      sql.raw(
        `("type" in (${CREDIT_NOTE_TYPES})) = ("credit_note_of_id" is not null) and ("credit_note_of_id" is null or ("reason" is not null and length(btrim("reason")) > 0))`,
      ),
    ),
    check(
      'invoice_attempts_check',
      sql`${table.attempts} >= 0 and (${table.expectedNumber} is null or ${table.expectedNumber} > 0)`,
    ),
    check('invoice_lookup_misses_check', sql`${table.lookupMisses} >= 0`),
    check(
      'invoice_authority_last_check',
      sql`${table.authorityLastAtMark} is null or ${table.authorityLastAtMark} >= 0`,
    ),
    uniqueIndex('invoice_idempotency_key').on(table.tenantId, table.idempotencyKey),
    uniqueIndex('invoice_number_key')
      .on(table.tenantId, table.pointOfSale, table.type, table.number)
      .where(sql`${table.number} is not null`),
    // A CAE is the answer of the authority to one voucher: two vouchers of an organization never share it.
    uniqueIndex('invoice_cae_key')
      .on(table.tenantId, table.cae)
      .where(sql`${table.cae} is not null`),
    // A rejected attempt is retried once: the new attempt is the only successor.
    uniqueIndex('invoice_previous_attempt_key')
      .on(table.tenantId, table.previousAttemptId)
      .where(sql`${table.previousAttemptId} is not null`),
    index('invoice_status_idx').on(table.tenantId, table.status, table.createdAt),
    index('invoice_patient_idx').on(table.tenantId, table.patientId, table.createdAt),
    index('invoice_credit_note_of_idx')
      .on(table.tenantId, table.creditNoteOfId)
      .where(sql`${table.creditNoteOfId} is not null`),
    index('invoice_due_idx')
      .on(table.tenantId, table.nextAttemptAt)
      .where(sql`${table.status} = 'pending'`),
  ],
);

export type InvoiceRow = typeof invoice.$inferSelect;
export type NewInvoiceRow = typeof invoice.$inferInsert;

/**
 * What an invoice covers of one charge line, in cents. Written with the invoice and never changed
 * (a trigger keeps `charge_line.invoiced_cents` in step, and refuses a line added later or one
 * that changes). `charge_id` and `description` are snapshots: the description is the generic
 * wording of the service, never anything clinical.
 */
export const invoiceLine = tenantTable(
  'invoice_line',
  {
    invoiceId: uuid('invoice_id').notNull(),
    chargeLineId: uuid('charge_line_id').notNull(),
    chargeId: uuid('charge_id').notNull(),
    position: smallint('position').notNull(),
    description: text('description').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'invoice_line_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'invoice_line_invoice_fkey',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoice.tenantId, invoice.id],
    }),
    foreignKey({
      name: 'invoice_line_charge_line_fkey',
      columns: [table.tenantId, table.chargeLineId],
      foreignColumns: [chargeLine.tenantId, chargeLine.id],
    }),
    check('invoice_line_amount_check', sql`${table.amountCents} > 0`),
    check(
      'invoice_line_description_check',
      sql`length(btrim(${table.description})) between 1 and 200`,
    ),
    uniqueIndex('invoice_line_charge_line_key').on(
      table.tenantId,
      table.invoiceId,
      table.chargeLineId,
    ),
    uniqueIndex('invoice_line_position_key').on(table.tenantId, table.invoiceId, table.position),
    index('invoice_line_charge_line_idx').on(table.tenantId, table.chargeLineId),
    index('invoice_line_charge_idx').on(table.tenantId, table.chargeId),
  ],
);

export type InvoiceLineRow = typeof invoiceLine.$inferSelect;

/**
 * The PDF of an issued invoice (stored in the organization's bucket) and the fact that it was
 * sent. The invoice itself never changes, so these facts live here. A row is written once; only
 * the delivery can be filled in afterwards, once.
 */
export const invoiceDocument = tenantTable(
  'invoice_document',
  {
    invoiceId: uuid('invoice_id').notNull(),
    objectKey: text('object_key').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Why nothing was sent (no email on file, the patient asked not to receive email). */
    deliverySkippedReason: text('delivery_skipped_reason'),
  },
  (table) => [
    foreignKey({
      name: 'invoice_document_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'invoice_document_invoice_fkey',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoice.tenantId, invoice.id],
    }),
    check('invoice_document_size_check', sql`${table.sizeBytes} > 0`),
    check(
      'invoice_document_delivery_check',
      sql`not (${table.deliveredAt} is not null and ${table.deliverySkippedReason} is not null)`,
    ),
    uniqueIndex('invoice_document_invoice_key').on(table.tenantId, table.invoiceId),
  ],
);

export type InvoiceDocumentRow = typeof invoiceDocument.$inferSelect;

/**
 * A number of a series that the authority may hold a voucher under, and that no invoice records
 * (JD-S4 R3-3): the number an invoice expected when it was replaced by a manual voucher without
 * knowing whether it had been issued, and the number of a voucher that arrived for an invoice somebody
 * had already closed. A voucher exists there that is NOT the voucher of any invoice that asks later,
 * so a lookup never adopts it and the next number expected is counted after it. Written once, never
 * changed or removed (the invoice that closed cannot carry it: a closed invoice is closed to any write).
 */
export const invoiceStrayVoucher = tenantTable(
  'invoice_stray_voucher',
  {
    invoiceId: uuid('invoice_id').notNull(),
    pointOfSale: integer('point_of_sale').notNull(),
    type: text('type').notNull(),
    number: bigint('number', { mode: 'number' }).notNull(),
    /**
     * Why the number is remembered. `orphaned` (a voucher arrived for a closed invoice) and `unmatched`
     * (a voucher found or issued that no invoice can record) are vouchers that certainly exist;
     * `replaced_unresolved` and `parked_unknown` are numbers where one MAY exist (an invoice replaced or
     * parked without knowing whether it was issued): unconfirmed until an invoice of the series records
     * a higher number (JD-S4 R4-1, R4-3).
     */
    reason: text('reason').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'invoice_stray_voucher_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'invoice_stray_voucher_invoice_fkey',
      columns: [table.tenantId, table.invoiceId],
      foreignColumns: [invoice.tenantId, invoice.id],
    }),
    check('invoice_stray_voucher_number_check', sql`${table.number} > 0`),
    check(
      'invoice_stray_voucher_reason_check',
      sql`${table.reason} in ('replaced_unresolved', 'orphaned', 'unmatched', 'parked_unknown')`,
    ),
    uniqueIndex('invoice_stray_voucher_number_key').on(
      table.tenantId,
      table.pointOfSale,
      table.type,
      table.number,
    ),
    index('invoice_stray_voucher_invoice_idx').on(table.tenantId, table.invoiceId),
  ],
);

export type InvoiceStrayVoucherRow = typeof invoiceStrayVoucher.$inferSelect;

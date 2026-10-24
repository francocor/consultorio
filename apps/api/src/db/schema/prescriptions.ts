import { PRESCRIPTION_STATUSES } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { encounter } from './clinical.js';
import { patient } from './patients.js';
import { professional } from './staff.js';
import { tenant } from './tenant.js';

// Tables of the prescriptions module (prescription, erx_connection), track A3
// (S5.04). Migrations come from `pnpm db:new 5a3 <name>` (docs/migration-ranges.md): 0530.

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/** What a prescription that is not issued yet is waiting for. */
export const PRESCRIPTION_DELIVERY_STATES = [
  'retrying',
  'awaiting_reconciliation',
  'needs_attention',
] as const;
export type PrescriptionDeliveryState = (typeof PRESCRIPTION_DELIVERY_STATES)[number];

/**
 * A prescription (e-prescription, Ley 27.553). It is CLINICAL: only a health professional's
 * transaction sees a row, and only the prescriber and the professionals who treat the patient may
 * read it. The template kind the clinical policies are given is the constant `prescription`, which
 * `app.clinical_readable` never shares (design D17): the organization's sharing scope never opens
 * one.
 *
 * - `content_enc` is the whole prescription (patient, prescriber, date, coverage and the
 *   medications), encrypted with the data key of the organization and bound to this row. The
 *   patient and the prescriber are copied into it when the prescription is made, so what was issued
 *   never changes with the record of either.
 * - `status` is exactly one of six. `pending_submission` is not valid: only the provider's answer
 *   makes a prescription `issued`. `draft` is a prescription the provider refused.
 * - `delivery_state`, `attempts` and the two dates are the bookkeeping of the submission, for a
 *   prescription that is not issued: `awaiting_reconciliation` is written BEFORE the provider is
 *   called, so a crash after it answered is found by asking the provider for the key.
 * - The idempotency key is global (the provider serves many organizations) and is derived from the
 *   organization and the prescription, never taken from the client. `client_key` is the one the
 *   form made, so a double submission answers with the prescription it already made.
 * - Nothing here is deleted or emptied, and the content of a prescription the provider confirmed
 *   never changes (the triggers of migration 0530 also stop the owner).
 */
export const prescription = tenantTable(
  'prescription',
  {
    patientId: uuid('patient_id').notNull(),
    authorProfessionalId: uuid('author_professional_id').notNull(),
    encounterId: uuid('encounter_id'),
    clientKey: uuid('client_key').notNull(),
    status: text('status').notNull().default('pending_submission'),
    /** Repeats the shape of the other clinical rows; a prescription is never author-only. */
    visibility: text('visibility').notNull().default('default'),
    contentEnc: bytea('content_enc').notNull(),
    /** The date printed on the prescription. */
    prescriptionDate: date('prescription_date', { mode: 'string' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    externalId: text('external_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    /** Issued by the professional on the provider's own site; the identifier was typed in. */
    registeredManually: boolean('registered_manually').notNull().default(false),
    /** The prescription was made for a simulated provider: its document has no legal validity. */
    simulated: boolean('simulated').notNull().default(false),
    /** The words of the provider about a refusal. */
    rejectionMessage: text('rejection_message'),
    cancelReasonEnc: bytea('cancel_reason_enc'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    deliveryState: text('delivery_state'),
    attempts: integer('attempts').notNull().default(0),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    /** The last time the provider was asked where an issued prescription stands. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** Where the PDF lives in the storage of the organization, once rendered. */
    documentKey: text('document_key'),
    version: integer('version').notNull().default(1),
    /**
     * Which submission the provider key belongs to. A prescription the provider refused is corrected
     * and sent again under a NEW key (the old one is bound to the refused fingerprint), so the
     * version goes up on that one transition and the key is derived from it (JD-S5 R1-S5-4).
     */
    submissionVersion: integer('submission_version').notNull().default(1),
    /**
     * When the provider may first have been asked to issue this prescription. Set before the call
     * and never cleared: whatever state the row is parked in later, a row with this mark is checked
     * against the provider before it is cancelled or registered by hand (JD-S5 R1-S5-3).
     */
    providerContactedAt: timestamp('provider_contacted_at', { withTimezone: true }),
    /**
     * Until when an attempt that holds no connection (the one a request starts) owns the row. Another
     * attempt, a cancellation and a manual registration leave the row alone while it is in the future.
     */
    attemptLeaseUntil: timestamp('attempt_lease_until', { withTimezone: true }),
    /**
     * Who holds that lease (JD-S5 R2-7): a lease is released only by the attempt that took it, so an
     * attempt that overran and finds another one in charge does not end the lease of the other.
     */
    attemptLeaseToken: uuid('attempt_lease_token'),
    /**
     * Until when a request to the provider that timed out may still be in flight (JD-S5 R2-3). The
     * caller stopped waiting, the provider did not: until then nothing is sent again, nothing is
     * cancelled here and nothing is registered by hand, because the provider may be about to issue.
     */
    providerInFlightUntil: timestamp('provider_in_flight_until', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'prescription_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'prescription_patient_fkey',
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patient.tenantId, patient.id],
    }),
    foreignKey({
      name: 'prescription_author_fkey',
      columns: [table.tenantId, table.authorProfessionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'prescription_encounter_fkey',
      columns: [table.tenantId, table.encounterId],
      foreignColumns: [encounter.tenantId, encounter.id],
    }),
    check('prescription_status_check', sql.raw(`"status" in (${list(PRESCRIPTION_STATUSES)})`)),
    check('prescription_visibility_check', sql`${table.visibility} = 'default'`),
    check(
      'prescription_delivery_state_check',
      sql.raw(
        `"delivery_state" is null or "delivery_state" in (${list(PRESCRIPTION_DELIVERY_STATES)})`,
      ),
    ),
    // The shape of each status, so a row cannot be half issued or half cancelled. A prescription
    // that is waiting for the provider has no identifier yet.
    check(
      'prescription_state_check',
      sql`(
        (${table.status} in ('draft', 'pending_submission')
          and ${table.issuedAt} is null)
        or (${table.status} in ('issued', 'dispensed', 'expired')
          and ${table.externalId} is not null and ${table.issuedAt} is not null)
        or (${table.status} = 'cancelled')
      )
      and ((${table.status} = 'cancelled') = (${table.cancelReasonEnc} is not null))
      and ((${table.status} = 'cancelled') = (${table.cancelledAt} is not null))
      and (${table.registeredManually} = false or ${table.externalId} is not null)
      and (${table.deliveryState} is null or ${table.status} in ('draft', 'pending_submission'))`,
    ),
    check('prescription_attempts_check', sql`${table.attempts} >= 0`),
    check('prescription_version_check', sql`${table.version} >= 1`),
    check('prescription_submission_version_check', sql`${table.submissionVersion} >= 1`),
    uniqueIndex('prescription_client_key').on(table.tenantId, table.clientKey),
    uniqueIndex('prescription_idempotency_key').on(table.idempotencyKey),
    uniqueIndex('prescription_external_key')
      .on(table.tenantId, table.externalId)
      .where(sql`${table.externalId} is not null`),
    index('prescription_patient_idx').on(table.tenantId, table.patientId, table.createdAt),
    index('prescription_author_idx').on(
      table.tenantId,
      table.authorProfessionalId,
      table.createdAt,
    ),
    // What the reconciliation job looks at: the prescriptions the provider has not settled.
    index('prescription_open_idx')
      .on(table.tenantId, table.authorProfessionalId, table.nextAttemptAt)
      .where(sql`${table.status} in ('pending_submission', 'issued')`),
  ],
);

export type PrescriptionRow = typeof prescription.$inferSelect;

/**
 * The connection of an organization to the provider: whether e-prescription is switched on, which
 * provider the deployment serves it with and, for a real provider, its credentials (encrypted with
 * the data key of the organization and never returned). One row per organization.
 */
export const erxConnection = tenantTable(
  'erx_connection',
  {
    providerKey: text('provider_key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    credentialsEnc: bytea('credentials_enc'),
    status: text('status').notNull().default('inactive'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'erx_connection_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    check('erx_connection_status_check', sql`${table.status} in ('active', 'inactive')`),
    check(
      'erx_connection_provider_key_check',
      sql`${table.providerKey} ~ '^[a-z][a-z0-9_-]{0,39}$'`,
    ),
    uniqueIndex('erx_connection_tenant_key').on(table.tenantId),
  ],
);

export type ErxConnectionRow = typeof erxConnection.$inferSelect;

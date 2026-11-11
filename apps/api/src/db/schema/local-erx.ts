import { ERX_SIMULATOR_MODES } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * Platform tables of the local e-prescription simulator (`ERX_PROVIDER=local`). They have no
 * `tenant_id` and no row level security on purpose: the simulator stands in for the authorized
 * platform, which is outside every organization and tells them apart by the idempotency key the
 * server derives from the organization and the prescription. They are never read in production
 * (the guard refuses the simulator there). The API and the worker share them through Postgres.
 *
 * The simulator keeps no medication, patient or prescriber: a prescription is the identifier it
 * gave, the state it is in and the digest of what was asked, which is all it needs to answer the
 * way a provider does. Nothing is deleted: a reset moves `local_erx_control.epoch` forward and every
 * query looks at the current epoch only.
 */

/** The one row of controls of the simulator. */
export const localErxControl = pgTable(
  'local_erx_control',
  {
    id: smallint('id').primaryKey().default(1),
    mode: text('mode').notNull().default('ok'),
    /** Moves forward on reset: the prescriptions and requests of older epochs no longer exist for it. */
    epoch: integer('epoch').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('local_erx_control_single_row_check', sql`${table.id} = 1`),
    check('local_erx_control_mode_check', sql.raw(`"mode" in (${list(ERX_SIMULATOR_MODES)})`)),
  ],
);

/** A prescription the simulator issued, with the state a pharmacy or the calendar gave it. */
export const localErxPrescription = pgTable(
  'local_erx_prescription',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    externalId: text('external_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    state: text('state').notNull().default('issued'),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check(
      'local_erx_prescription_state_check',
      sql.raw(`"state" in ('issued', 'cancelled', 'dispensed', 'expired')`),
    ),
    check(
      'local_erx_prescription_cancel_check',
      sql`(${table.state} = 'cancelled') = (${table.cancelReason} is not null)`,
    ),
    uniqueIndex('local_erx_prescription_external_key').on(table.epoch, table.externalId),
    uniqueIndex('local_erx_prescription_key').on(table.epoch, table.idempotencyKey),
    index('local_erx_prescription_created_idx').on(table.createdAt),
  ],
);

/**
 * The answer given to each idempotency key, so the same key gets the same answer however many
 * times it arrives. The fingerprint is a digest of what was asked: a key that comes back with
 * another request is refused. An `issue` that was rejected has no prescription; a `cancel` points
 * at the prescription it cancelled (or carries the refusal).
 */
export const localErxRequest = pgTable(
  'local_erx_request',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    kind: text('kind').notNull(),
    fingerprint: text('fingerprint').notNull(),
    outcome: text('outcome').notNull(),
    prescriptionId: uuid('prescription_id'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('local_erx_request_kind_check', sql.raw(`"kind" in ('issue', 'cancel')`)),
    check(
      'local_erx_request_outcome_check',
      sql.raw(`"outcome" in ('issued', 'cancelled', 'rejected')`),
    ),
    check(
      'local_erx_request_shape_check',
      sql`(${table.outcome} = 'rejected') = (${table.message} is not null)
          and (${table.outcome} = 'rejected') = (${table.prescriptionId} is null)`,
    ),
    uniqueIndex('local_erx_request_key').on(table.epoch, table.idempotencyKey),
  ],
);

export type LocalErxPrescriptionRow = typeof localErxPrescription.$inferSelect;

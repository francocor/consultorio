import { AFIP_SIMULATOR_MODES } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
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
 * Platform tables of the local AFIP simulator (`AFIP_PROVIDER=local`). They have no `tenant_id`
 * and no row level security on purpose: the simulator stands in for the tax authority, which is
 * outside every organization, and tells organizations apart by the CUIT of the issuer exactly as
 * the authority does. They are never read in production (the guard refuses the simulator there).
 * The API and the worker share them through Postgres.
 *
 * Nothing is ever deleted: a reset moves `local_afip_control.epoch` forward, and every query looks
 * at the current epoch only, so numbering starts again with no row removed.
 */

/** The one row of controls of the simulator. */
export const localAfipControl = pgTable(
  'local_afip_control',
  {
    id: smallint('id').primaryKey().default(1),
    mode: text('mode').notNull().default('ok'),
    /** Moves forward on reset: the vouchers and requests of older epochs no longer exist for it. */
    epoch: integer('epoch').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('local_afip_control_single_row_check', sql`${table.id} = 1`),
    check('local_afip_control_mode_check', sql.raw(`"mode" in (${list(AFIP_SIMULATOR_MODES)})`)),
  ],
);

/** A voucher the simulator authorized: number, CAE and expiry, numbered per issuer, point of sale and type. */
export const localAfipVoucher = pgTable(
  'local_afip_voucher',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    issuerCuit: text('issuer_cuit').notNull(),
    pointOfSale: integer('point_of_sale').notNull(),
    type: text('type').notNull(),
    number: integer('number').notNull(),
    cae: text('cae').notNull(),
    caeExpiresOn: date('cae_expires_on', { mode: 'string' }).notNull(),
    issueDate: date('issue_date', { mode: 'string' }).notNull(),
    totalCents: bigint('total_cents', { mode: 'number' }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('local_afip_voucher_number_key').on(
      table.epoch,
      table.issuerCuit,
      table.pointOfSale,
      table.type,
      table.number,
    ),
    check('local_afip_voucher_cae_check', sql`${table.cae} ~ '^[1-9][0-9]{13}$'`),
    check('local_afip_voucher_number_check', sql`${table.number} >= 1`),
    index('local_afip_voucher_created_idx').on(table.createdAt),
  ],
);

/**
 * What the simulator answered to an idempotency key: the voucher it authorized, or the rejection.
 * A retry with the same key and the same request gets the same answer; with another request, a
 * rejection.
 */
export const localAfipRequest = pgTable(
  'local_afip_request',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    epoch: integer('epoch').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    outcome: text('outcome').notNull(),
    voucherId: uuid('voucher_id'),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('local_afip_request_key').on(table.epoch, table.idempotencyKey),
    check('local_afip_request_outcome_check', sql`${table.outcome} in ('authorized', 'rejected')`),
    check(
      'local_afip_request_shape_check',
      sql`(${table.outcome} = 'authorized') = (${table.voucherId} is not null)
          and (${table.outcome} = 'rejected') = (${table.message} is not null)`,
    ),
  ],
);

export type LocalAfipVoucherRow = typeof localAfipVoucher.$inferSelect;

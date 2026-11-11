import { sql } from 'drizzle-orm';
import { boolean, check, date, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/**
 * Platform catalogs: reference data shared by every tenant. They have no `tenant_id` and no row
 * level security, so every tenant reads the same rows. The runtime role can only SELECT (the
 * migration revokes the rest); the platform operator maintains them as data, with no release.
 */

export const holidayCatalog = pgTable(
  'holiday_catalog',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    country: text('country').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The operator removes a wrongly added holiday by ending it; the row stays as history. */
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (table) => [
    unique('holiday_catalog_country_date_name_key').on(table.country, table.date, table.name),
    check('holiday_catalog_kind_check', sql`${table.kind} in ('national', 'bridge')`),
  ],
);

export const payer = pgTable(
  'payer',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`app.uuid_v7()`),
    country: text('country').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('payer_country_code_key').on(table.country, table.code),
    check('payer_kind_check', sql`${table.kind} in ('obra_social', 'prepaga', 'private')`),
  ],
);

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenantTable } from './_helpers.js';
import { payer } from './platform-catalogs.js';
import { appointmentType } from './scheduling-config.js';
import { professional } from './staff.js';
import { location, tenant } from './tenant.js';

// Pricing tables of the billing module (price, tenant_payer, payer_plan_price), track A (S4.01).
// Every amount is a whole number of CENTS of ARS (`*_cents`, bigint read as a number): there is no
// float and no `numeric` money anywhere in billing.

/** Stands for "any professional" and "any location" in the keys that keep a price unique. */
const NIL = sql`'00000000-0000-0000-0000-000000000000'::uuid`;

/**
 * A payer (obra social or prepaga) the organization bills, copied from the platform catalog
 * (`payer_id`) or named by the organization (`custom_name`); exactly one of the two. It is
 * deactivated, never deleted: a charge that was made for it keeps pointing at it. A deactivated
 * payer is not offered for new charges (billing-payments, "Deactivated payer").
 */
export const tenantPayer = tenantTable(
  'tenant_payer',
  {
    payerId: uuid('payer_id'),
    customName: text('custom_name'),
    /**
     * The tax id of the payer, 11 digits, validated through the country pack. The platform catalog
     * has none, and a Factura A to a payer needs it (e-invoicing-afip); null until the organization
     * enters it.
     */
    cuit: text('cuit'),
    active: boolean('active').notNull().default(true),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (table) => [
    check('tenant_payer_cuit_check', sql`${table.cuit} is null or ${table.cuit} ~ '^[0-9]{11}$'`),
    foreignKey({
      name: 'tenant_payer_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'tenant_payer_payer_id_fkey',
      columns: [table.payerId],
      foreignColumns: [payer.id],
    }),
    check(
      'tenant_payer_one_source_check',
      sql`(${table.payerId} is null) <> (${table.customName} is null)`,
    ),
    check('tenant_payer_active_check', sql`${table.active} = (${table.deactivatedAt} is null)`),
    uniqueIndex('tenant_payer_catalog_key')
      .on(table.tenantId, table.payerId)
      .where(sql`${table.payerId} is not null`),
    uniqueIndex('tenant_payer_custom_key')
      .on(table.tenantId, sql`lower(${table.customName})`)
      .where(sql`${table.customName} is not null`),
  ],
);

export type TenantPayerRow = typeof tenantPayer.$inferSelect;

/**
 * A private (particular) price of an appointment type. Narrower scopes win over wider ones: a
 * professional, then a specialty, then a location, then the general price (`price-resolution.ts`).
 * It starts to apply on `effective_from`; the latest one that is not in the future is used. A
 * charge copies the figures it applied (the snapshot), so changing a price never changes a charge.
 * Amounts are positive: a service with no price has no charge.
 */
export const price = tenantTable(
  'price',
  {
    appointmentTypeId: uuid('appointment_type_id').notNull(),
    professionalId: uuid('professional_id'),
    /** A discipline of the professional (`professional.specialties`); null for any. */
    specialty: text('specialty'),
    locationId: uuid('location_id'),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by'),
  },
  (table) => [
    foreignKey({
      name: 'price_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'price_type_fkey',
      columns: [table.tenantId, table.appointmentTypeId],
      foreignColumns: [appointmentType.tenantId, appointmentType.id],
    }),
    foreignKey({
      name: 'price_professional_fkey',
      columns: [table.tenantId, table.professionalId],
      foreignColumns: [professional.tenantId, professional.id],
    }),
    foreignKey({
      name: 'price_location_fkey',
      columns: [table.tenantId, table.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check('price_amount_check', sql`${table.amountCents} > 0`),
    check(
      'price_specialty_check',
      sql`${table.specialty} is null or length(btrim(${table.specialty})) > 0`,
    ),
    // One active price per scope and date: the same question never has two answers.
    uniqueIndex('price_scope_key')
      .on(
        table.tenantId,
        table.appointmentTypeId,
        sql`coalesce(${table.professionalId}, ${NIL})`,
        sql`coalesce(lower(${table.specialty}), '')`,
        sql`coalesce(${table.locationId}, ${NIL})`,
        table.effectiveFrom,
      )
      .where(sql`${table.active}`),
  ],
);

export type PriceRow = typeof price.$inferSelect;

/**
 * What a payer plan pays and what the patient adds for one appointment type: the amount the payer
 * covers, the copago the patient pays, and a plus (a surcharge over the covered amount) the
 * organization may charge. `plan_name` null means every plan of the payer; a named plan wins over
 * it. The copago and the plus are separate lines on the charge.
 */
export const payerPlanPrice = tenantTable(
  'payer_plan_price',
  {
    tenantPayerId: uuid('tenant_payer_id').notNull(),
    planName: text('plan_name'),
    appointmentTypeId: uuid('appointment_type_id').notNull(),
    payerAmountCents: bigint('payer_amount_cents', { mode: 'number' }).notNull(),
    copagoCents: bigint('copago_cents', { mode: 'number' }).notNull().default(0),
    plusCents: bigint('plus_cents', { mode: 'number' }).notNull().default(0),
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by'),
  },
  (table) => [
    foreignKey({
      name: 'payer_plan_price_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'payer_plan_price_payer_fkey',
      columns: [table.tenantId, table.tenantPayerId],
      foreignColumns: [tenantPayer.tenantId, tenantPayer.id],
    }),
    foreignKey({
      name: 'payer_plan_price_type_fkey',
      columns: [table.tenantId, table.appointmentTypeId],
      foreignColumns: [appointmentType.tenantId, appointmentType.id],
    }),
    check(
      'payer_plan_price_amounts_check',
      sql`${table.payerAmountCents} >= 0 and ${table.copagoCents} >= 0 and ${table.plusCents} >= 0
        and ${table.payerAmountCents} + ${table.copagoCents} + ${table.plusCents} > 0`,
    ),
    check(
      'payer_plan_price_plan_check',
      sql`${table.planName} is null or length(btrim(${table.planName})) > 0`,
    ),
    uniqueIndex('payer_plan_price_scope_key')
      .on(
        table.tenantId,
        table.tenantPayerId,
        sql`coalesce(lower(${table.planName}), '')`,
        table.appointmentTypeId,
        table.effectiveFrom,
      )
      .where(sql`${table.active}`),
  ],
);

export type PayerPlanPriceRow = typeof payerPlanPrice.$inferSelect;

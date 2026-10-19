import { FISCAL_ENVIRONMENTS, TAX_CONDITIONS } from '@consultorio/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, tenantTable } from './_helpers.js';
import { tenant } from './tenant.js';

const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/**
 * The fiscal identity of an organization (e-invoicing-afip, "Fiscal configuration per
 * organization"): one row per organization. The CUIT is stored as 11 digits; its check digit is
 * validated by the country pack before it gets here. Whether e-invoicing is switched on is
 * `settings.integrations.einvoicing`, not a column of this table.
 */
export const fiscalProfile = tenantTable(
  'fiscal_profile',
  {
    cuit: text('cuit').notNull(),
    taxCondition: text('tax_condition').notNull(),
    businessName: text('business_name').notNull(),
    address: text('address').notNull(),
    activityStartedOn: date('activity_started_on', { mode: 'string' }).notNull(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    foreignKey({
      name: 'fiscal_profile_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    uniqueIndex('fiscal_profile_tenant_key').on(table.tenantId),
    check('fiscal_profile_cuit_check', sql`${table.cuit} ~ '^[0-9]{11}$'`),
    check(
      'fiscal_profile_tax_condition_check',
      sql.raw(`"tax_condition" in (${list(TAX_CONDITIONS)})`),
    ),
    check(
      'fiscal_profile_name_check',
      sql`length(btrim(${table.businessName})) > 0 and length(btrim(${table.address})) > 0`,
    ),
  ],
);

/**
 * A point of sale (punto de venta). The AFIP environment belongs to the point of sale, not to the
 * organization: one organization may have a point of sale in homologation and another in
 * production. A point of sale is deactivated, never deleted: issued invoices point at its number.
 */
export const pointOfSale = tenantTable(
  'point_of_sale',
  {
    number: integer('number').notNull(),
    environment: text('environment').notNull().default('homologation'),
    active: boolean('active').notNull().default(true),
  },
  (table) => [
    foreignKey({
      name: 'point_of_sale_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    uniqueIndex('point_of_sale_number_key').on(table.tenantId, table.number),
    check('point_of_sale_number_check', sql`${table.number} between 1 and 99999`),
    check(
      'point_of_sale_environment_check',
      sql.raw(`"environment" in (${list(FISCAL_ENVIRONMENTS)})`),
    ),
  ],
);

/**
 * The certificate and private key of the organization for the tax authority. Both are encrypted
 * with the tenant data key (AES-256-GCM, bound to this row), and no endpoint returns them. A new
 * upload replaces the active credential: the old row stays, inactive, as history.
 *
 * `not_after` and `subject_cuit` are read from the certificate when it is uploaded; the state of
 * the credential (valid, expiring, expired, invalid) is derived from them and the clock, so it is
 * never stale. `expiry_warned_at` keeps the watch job from emailing the owner twice for the same
 * certificate.
 */
export const fiscalCredential = tenantTable(
  'fiscal_credential',
  {
    certificateEnc: bytea('certificate_enc').notNull(),
    privateKeyEnc: bytea('private_key_enc').notNull(),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    subjectCuit: text('subject_cuit').notNull(),
    /** SHA-256 of the certificate in DER form, hex. It identifies the certificate, never reveals it. */
    fingerprint: text('fingerprint').notNull(),
    active: boolean('active').notNull().default(true),
    replacedAt: timestamp('replaced_at', { withTimezone: true }),
    expiryWarnedAt: timestamp('expiry_warned_at', { withTimezone: true }),
    uploadedBy: uuid('uploaded_by'),
  },
  (table) => [
    foreignKey({
      name: 'fiscal_credential_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    uniqueIndex('fiscal_credential_active_key')
      .on(table.tenantId)
      .where(sql`${table.active}`),
    check('fiscal_credential_cuit_check', sql`${table.subjectCuit} ~ '^[0-9]{11}$'`),
    check('fiscal_credential_fingerprint_check', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check('fiscal_credential_active_check', sql`(${table.active}) = (${table.replacedAt} is null)`),
    check('fiscal_credential_window_check', sql`${table.notAfter} > ${table.notBefore}`),
  ],
);

export type FiscalProfileRow = typeof fiscalProfile.$inferSelect;
export type PointOfSaleRow = typeof pointOfSale.$inferSelect;
export type FiscalCredentialRow = typeof fiscalCredential.$inferSelect;

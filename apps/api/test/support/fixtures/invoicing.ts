import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { returningId, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the tables of invoicing (track C): one valid row per table, for the generated
 * isolation suite. Never a real certificate: the ciphertext columns hold placeholder bytes.
 */

let pointOfSaleNumber = 0;

export const fixtures: Record<string, TenantTableFixture> = {
  fiscal_profile: {
    // One row per organization: the suite inserts for the same tenant several times, so the
    // fixture updates the row that is already there (the policy still checks the proposed row).
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO fiscal_profile
              (tenant_id, cuit, tax_condition, business_name, address, activity_started_on)
              VALUES (${tenantId}, '20123456786', 'monotributo', 'Consultorio de prueba',
                      'Calle 1, CABA', '2020-01-01')
              ON CONFLICT (tenant_id) DO UPDATE SET business_name = EXCLUDED.business_name
              RETURNING id`,
      ),
  },
  point_of_sale: {
    insert: (tx, tenantId) => {
      pointOfSaleNumber = (pointOfSaleNumber % 99_000) + 1;
      return returningId(
        tx,
        sql`INSERT INTO point_of_sale (tenant_id, number)
              VALUES (${tenantId}, ${pointOfSaleNumber})
              ON CONFLICT (tenant_id, number) DO UPDATE SET active = true
              RETURNING id`,
      );
    },
  },
  fiscal_credential: {
    // History rows (replaced), so any number of them can exist next to the one active credential.
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO fiscal_credential
              (tenant_id, certificate_enc, private_key_enc, not_before, not_after,
               subject_cuit, fingerprint, active, replaced_at)
              VALUES (${tenantId}, '\\x00'::bytea, '\\x00'::bytea,
                      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '20123456786',
                      ${randomUUID().replaceAll('-', '').padEnd(64, '0')}, false, now())
              RETURNING id`,
      ),
  },
};

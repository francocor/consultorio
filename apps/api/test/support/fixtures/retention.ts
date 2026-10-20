import { sql } from 'drizzle-orm';

import { insertProfessional, returningId, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the tables of the retention track (Stage 6, track C): one valid row per table, for the
 * generated isolation suite. The overrides replace a foreign key with an id of another organization.
 */
export const fixtures: Record<string, TenantTableFixture> = {
  // A clinical package: one per professional, so a new professional makes a new row every time (the
  // administrative one is unique per organization, which the suite would insert twice).
  export_package: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO export_package (tenant_id, kind, professional_id)
              VALUES (${tenantId}, 'clinical',
                      ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))})
              RETURNING id`,
      ),
  },
};

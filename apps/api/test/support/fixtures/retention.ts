import { sql } from 'drizzle-orm';

import {
  insertProfessional,
  returningId,
  unique,
  type TenantTableFixture,
} from '../fixture-helpers.js';

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
  // The key pair of an organization: a version per row, so a new one every time.
  archive_key: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO archive_key (tenant_id, version, public_key, public_key_sha256, wrapped_private_key)
              VALUES (${tenantId}, (SELECT coalesce(max(version), 0) + 1 FROM archive_key), ''::bytea, ${unique('sha')}, ''::bytea)
              RETURNING id`,
      ),
  },
  // One archive per organization: the suite inserts for the same tenant several times, so the
  // fixture finds the row that is already there.
  tenant_archive: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`WITH made AS (
              INSERT INTO tenant_archive (tenant_id, archive_id, key_version)
              VALUES (${tenantId}, app.uuid_v7(), 1)
              ON CONFLICT (tenant_id) DO NOTHING
              RETURNING id
            )
            SELECT id FROM made
            UNION ALL
            SELECT id FROM tenant_archive WHERE tenant_id = ${tenantId}
            LIMIT 1`,
      ),
  },
};

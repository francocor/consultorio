import { sql } from 'drizzle-orm';

import { insertUser, returningId, unique, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the signup tables (track B): one valid row per table, for the generated isolation
 * suite. `terms_version` is a platform table (no organization) and is not listed here.
 */
export const fixtures: Record<string, TenantTableFixture> = {
  // One pending signup per organization: the suite inserts for the same tenant several times, so
  // the fixture updates the row that is already there (the policy still checks the proposed row).
  signup_pending: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO signup_pending
              (tenant_id, owner_email, owner_name, password_hash, terms_version,
               data_processing_version, accepted_at)
              VALUES (${tenantId}, ${`${unique('registro')}-${tenantId.slice(0, 8)}@example.test`},
                      'Ana Pérez', '$argon2id$fixture', 1, 1, now())
              ON CONFLICT (tenant_id) DO UPDATE SET owner_email = EXCLUDED.owner_email
              RETURNING id`,
      ),
  },
  terms_acceptance: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO terms_acceptance
              (tenant_id, user_id, terms_version, data_processing_version, accepted_at)
              VALUES (${tenantId}, ${overrides?.['user_id'] ?? (await insertUser(tx))}, 1, 1, now())
              RETURNING id`,
      ),
  },
};

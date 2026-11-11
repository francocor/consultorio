import { sql } from 'drizzle-orm';

import { returningId, unique, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the per-organization state tables: the guided first run and the feature switches.
 * They live in their own file to show the pattern every later table follows: a file in
 * `test/support/fixtures/` that exports `fixtures`.
 */
export const fixtures: Record<string, TenantTableFixture> = {
  onboarding_state: {
    // One row per organization: the suite inserts for the same tenant several times, so the
    // fixture updates the row that is already there (the policy still checks the proposed row).
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO onboarding_state (tenant_id, answers)
              VALUES (${tenantId}, '{"isProfessional": true}'::jsonb)
              ON CONFLICT (tenant_id) DO UPDATE SET answers = EXCLUDED.answers
              RETURNING id`,
      ),
  },
  tenant_feature: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO tenant_feature (tenant_id, feature, enabled)
              VALUES (${tenantId}, ${unique('feature')}, true)
              RETURNING id`,
      ),
  },
};

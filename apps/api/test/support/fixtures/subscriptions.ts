import { sql } from 'drizzle-orm';

import { returningId, unique, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the tables of the subscriptions module (track A): one valid row per table, for the
 * generated isolation suite. The starting plan is part of the schema (migration 0610), so the
 * fixture points at it; the runtime role cannot write plans.
 */
export const fixtures: Record<string, TenantTableFixture> = {
  subscription: {
    // One row per organization: the suite inserts for the same tenant several times, so the
    // fixture updates the row that is already there (the policy still checks the proposed row).
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO subscription (tenant_id, plan_id, status, trial_ends_at, overage_cap_messages)
              VALUES (${tenantId}, (SELECT id FROM plan WHERE key = 'standard'), 'trial',
                      now() + interval '14 days', 300)
              ON CONFLICT (tenant_id) DO UPDATE SET overage_cap_messages = excluded.overage_cap_messages
              RETURNING id`,
      ),
  },
  subscription_event: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO subscription_event (tenant_id, event_id, topic, resource_id, signed_at)
              VALUES (${tenantId}, ${unique('fixture-event')}, 'payment', ${unique('PAY')}, now())
              RETURNING id`,
      ),
  },
};

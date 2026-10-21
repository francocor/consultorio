import { sql } from 'drizzle-orm';

import type { Tx } from '../../../src/platform/db/tenant-context.js';
import {
  insertProfessional,
  returningId,
  unique,
  type TenantTableFixture,
} from '../fixture-helpers.js';

/**
 * Fixtures of the tables of the subscriptions module (track A): one valid row per table, for the
 * generated isolation suite. The starting plan is part of the schema (migration 0610), so the
 * fixture points at it; the runtime role cannot write plans.
 */

/** The subscription of the organization (one per organization): the row that is there, or a new one. */
function subscriptionOf(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO subscription (tenant_id, plan_id, status, trial_ends_at, overage_cap_messages)
          VALUES (${tenantId}, (SELECT id FROM plan WHERE key = 'standard'), 'trial',
                  now() + interval '14 days', 300)
          ON CONFLICT (tenant_id) DO UPDATE SET overage_cap_messages = excluded.overage_cap_messages
          RETURNING id`,
  );
}

let periods = 0;

/** A valid period no other fixture row of the same subscription has (years far from the tests' own). */
function freshPeriod(): string {
  periods += 1;
  const year = 2100 + Math.floor(periods / 12);
  return `${String(year)}-${String((periods % 12) + 1).padStart(2, '0')}`;
}

async function paymentOf(
  tx: Tx,
  tenantId: string,
  subscriptionId: string | undefined,
  statementId?: string,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO subscription_payment (tenant_id, subscription_id, provider_payment_id, purpose,
                                          reference, amount_cents, status, statement_id, provider_created_at)
          VALUES (${tenantId}, ${subscriptionId ?? (await subscriptionOf(tx, tenantId))},
                  ${unique('PAY')}, 'charge', ${unique('sub:fixture')}, 3600000, 'approved',
                  ${statementId ?? null}, now())
          RETURNING id`,
  );
}

export const fixtures: Record<string, TenantTableFixture> = {
  subscription: {
    // One row per organization: the suite inserts for the same tenant several times, so the
    // fixture updates the row that is already there (the policy still checks the proposed row).
    insert: (tx, tenantId) => subscriptionOf(tx, tenantId),
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
  subscription_attempt: {
    // A resolved attempt: only one open write of a kind may exist for a subscription.
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO subscription_attempt (tenant_id, subscription_id, kind, external_reference,
                                              idempotency_key, statement_id, state, marked_at, settle_until, resolved_at)
              VALUES (${tenantId}, ${overrides?.['subscription_id'] ?? (await subscriptionOf(tx, tenantId))},
                      'preapproval', ${unique('sub:fixture')}, ${unique('key')},
                      ${overrides?.['statement_id'] ?? null}, 'released',
                      now(), now() + interval '1 minute', now())
              RETURNING id`,
      ),
  },
  subscription_payment: {
    insert: (tx, tenantId, overrides) =>
      paymentOf(tx, tenantId, overrides?.['subscription_id'], overrides?.['statement_id']),
  },
  subscription_refund: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO subscription_refund (tenant_id, payment_id, provider_refund_id, amount_cents,
                                             source, provider_created_at)
              VALUES (${tenantId}, ${overrides?.['payment_id'] ?? (await paymentOf(tx, tenantId, undefined))},
                      ${unique('RFD')}, 100000, 'operator', now())
              RETURNING id`,
      ),
  },
  usage_record: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO usage_record (tenant_id, kind, professional_id, period, day)
              VALUES (${tenantId}, 'active_professional_day',
                      ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))},
                      '2026-09', '2026-09-01')
              RETURNING id`,
      ),
  },
  statement: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO statement (tenant_id, subscription_id, period, plan_id, professionals_counted,
                                   base_cents, total_cents, overage_cap_messages, lines, published_at,
                                   collect_after)
              VALUES (${tenantId}, ${overrides?.['subscription_id'] ?? (await subscriptionOf(tx, tenantId))},
                      ${freshPeriod()}, (SELECT id FROM plan WHERE key = 'standard'), 1,
                      1800000, 1800000, 300, '[]'::jsonb, now(), now() + interval '3 days')
              RETURNING id`,
      ),
  },
  subscription_notice: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO subscription_notice (tenant_id, subscription_id, kind, key)
              VALUES (${tenantId}, ${overrides?.['subscription_id'] ?? (await subscriptionOf(tx, tenantId))},
                      'past_due_started', ${unique('2026-10-27T15:00:00.000Z')})
              RETURNING id`,
      ),
  },
};

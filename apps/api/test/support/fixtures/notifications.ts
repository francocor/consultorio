import { sql } from 'drizzle-orm';

import { insertPatient, returningId, unique, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the tables of messaging (track A): one valid row per table, for the generated
 * isolation suite. The overrides replace a foreign key with an id of another organization.
 */

async function insertMessage(
  tx: Parameters<TenantTableFixture['insert']>[0],
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO message (tenant_id, patient_id, appointment_id, professional_id, kind, channel, dedupe_key, send_at)
          VALUES (${tenantId},
                  ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                  ${overrides?.['appointment_id'] ?? null},
                  ${overrides?.['professional_id'] ?? null},
                  'reminder', 'email', ${unique('fixture-message')}, now())
          RETURNING id`,
  );
}

export const fixtures: Record<string, TenantTableFixture> = {
  message: { insert: insertMessage },
  message_event: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO message_event (tenant_id, event_id, message_id, status)
              VALUES (${tenantId}, ${unique('fixture-event')},
                      ${overrides?.['message_id'] ?? (await insertMessage(tx, tenantId))}, 'delivered')
              RETURNING id`,
      ),
  },
  inbound_message: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO inbound_message (tenant_id, event_id, from_hash, outcome)
              VALUES (${tenantId}, ${unique('fixture-reply')}, 'hash', 'ignored')
              RETURNING id`,
      ),
  },
  channel_preference: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO channel_preference (tenant_id, patient_id, channel, state, source)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                      'email', 'opted_out', 'email_link')
              RETURNING id`,
      ),
  },
  message_attempt: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO message_attempt (tenant_id, message_id, attempt_no, outcome)
              VALUES (${tenantId},
                      ${overrides?.['message_id'] ?? (await insertMessage(tx, tenantId))},
                      1, 'accepted')
              RETURNING id`,
      ),
  },
};

import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { insertPatient, returningId, unique, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the portal tables (track B): one valid row per table, for the generated isolation
 * suite. The overrides replace a foreign key with an id of another organization, to prove the
 * composite foreign key refuses it.
 */

type Tx = Parameters<TenantTableFixture['insert']>[0];

async function insertIdentity(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO portal_identity (tenant_id, email)
          VALUES (${tenantId}, ${`${unique('portal')}@example.test`})
          RETURNING id`,
  );
}

async function insertLink(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO portal_link (tenant_id, portal_identity_id, patient_id, relationship)
          VALUES (${tenantId},
                  ${overrides?.['portal_identity_id'] ?? (await insertIdentity(tx, tenantId))},
                  ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                  'self')
          RETURNING id`,
  );
}

export const fixtures: Record<string, TenantTableFixture> = {
  portal_identity: { insert: insertIdentity },
  portal_link: { insert: insertLink },
  portal_session: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO portal_session
              (tenant_id, portal_identity_id, selected_link_id, token_hash, expires_at)
              VALUES (${tenantId},
                      ${overrides?.['portal_identity_id'] ?? (await insertIdentity(tx, tenantId))},
                      ${overrides?.['selected_link_id'] ?? null},
                      ${randomBytes(16).toString('hex')},
                      now() + interval '12 hours')
              RETURNING id`,
      ),
  },
};

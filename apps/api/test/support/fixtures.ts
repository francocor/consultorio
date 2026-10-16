import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '../../src/platform/db/tenant-context.js';

/**
 * One fixture per tenant table. The generated isolation suite uses it to put a row into a table
 * without knowing the table: a table with no fixture here FAILS the suite, so adding a tenant
 * table forces whoever adds it to say how to create a valid row.
 */
export interface TenantTableFixture {
  /**
   * Inserts one row owned by `tenantId` and returns its id. The caller has already set the tenant
   * context, which may differ from `tenantId` (that is how cross-tenant writes are tested).
   * `overrides` replaces foreign key columns, keyed by column name, with ids of another tenant.
   */
  insert(tx: Tx, tenantId: string, overrides?: Readonly<Record<string, string>>): Promise<string>;
}

async function returningId(tx: Tx, statement: ReturnType<typeof sql>): Promise<string> {
  const result = await tx.execute<{ id: string }>(statement);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('fixture insert returned no id');
  return id;
}

let versionCounter = 100;
/** Distinct key versions for fixtures (the version is unique per tenant). */
function nextVersion(): number {
  versionCounter += 1;
  return versionCounter;
}

let counter = 0;
/** Unique suffix so repeated fixtures never collide on a unique business key. */
export function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}`;
}

/**
 * A new account, inserted the way the application does it: acting AS that user. The account
 * policy only accepts the row of `app.user_id`, so the fixture points it at the new id for the
 * insert and puts the caller's value back afterwards.
 */
async function insertUser(tx: Tx): Promise<string> {
  const id = randomUUID();
  const previous = await tx.execute<{ value: string }>(
    sql`select current_setting('app.user_id') as value`,
  );
  await tx.execute(sql`select set_config('app.user_id', ${id}, true)`);
  await tx.execute(
    sql`INSERT INTO user_account (id, email, password_hash)
          VALUES (${id}, ${unique('fixture') + '@example.test'}, 'hash')`,
  );
  await tx.execute(sql`select set_config('app.user_id', ${previous.rows[0]?.value ?? ''}, true)`);
  return id;
}

async function insertMembership(tx: Tx, tenantId: string, userId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO membership (tenant_id, user_id, roles)
          VALUES (${tenantId}, ${userId}, ARRAY['reception']) RETURNING id`,
  );
}

async function insertProfessional(tx: Tx, tenantId: string): Promise<string> {
  const membershipId = await insertMembership(tx, tenantId, await insertUser(tx));
  return returningId(
    tx,
    sql`INSERT INTO professional (tenant_id, membership_id, specialties)
          VALUES (${tenantId}, ${membershipId}, ARRAY['general'])
          RETURNING id`,
  );
}

export const TENANT_FIXTURES: Record<string, TenantTableFixture> = {
  care_assignment: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO care_assignment (tenant_id, patient_id, professional_id, assigned_by)
              VALUES (${tenantId}, ${randomUUID()}, ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))}, ${randomUUID()})
              RETURNING id`,
      ),
  },
  care_relationship: {
    // The runtime role cannot write this table: the relationship appears through an assignment.
    insert: async (tx, tenantId, overrides) => {
      const patientId = randomUUID();
      await tx.execute(
        sql`INSERT INTO care_assignment (tenant_id, patient_id, professional_id, assigned_by)
              VALUES (${tenantId}, ${patientId}, ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))}, ${randomUUID()})`,
      );
      return returningId(tx, sql`SELECT id FROM care_relationship WHERE patient_id = ${patientId}`);
    },
  },
  action_token: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO action_token (tenant_id, kind, token_hash, subject_id, expires_at)
              VALUES (${tenantId}, 'password_reset', ${randomUUID()}, ${randomUUID()}, now() + interval '30 minutes')
              RETURNING id`,
      ),
  },
  membership: {
    insert: async (tx, tenantId) => insertMembership(tx, tenantId, await insertUser(tx)),
  },
  session: {
    insert: async (tx, tenantId, overrides) => {
      const userId = await insertUser(tx);
      const membershipId =
        overrides?.['membership_id'] ?? (await insertMembership(tx, tenantId, userId));
      return returningId(
        tx,
        sql`INSERT INTO session (tenant_id, user_id, membership_id, token_hash, expires_at)
              VALUES (${tenantId}, ${userId}, ${membershipId}, ${randomUUID()}, now() + interval '1 day')
              RETURNING id`,
      );
    },
  },
  login_challenge: {
    insert: async (tx, tenantId, overrides) => {
      const userId = await insertUser(tx);
      const membershipId =
        overrides?.['membership_id'] ?? (await insertMembership(tx, tenantId, userId));
      return returningId(
        tx,
        sql`INSERT INTO login_challenge (tenant_id, user_id, membership_id, token_hash, expires_at)
              VALUES (${tenantId}, ${userId}, ${membershipId}, ${randomUUID()}, now() + interval '5 minutes')
              RETURNING id`,
      );
    },
  },
  audit_event: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO audit_event (tenant_id, action, outcome)
              VALUES (${tenantId}, 'access.denied', 'deny')
              RETURNING id`,
      ),
  },
  job_execution: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO job_execution (tenant_id, queue, job_id)
              VALUES (${tenantId}, 'test.echo', ${randomUUID()})
              RETURNING id`,
      ),
  },
  tenant_key: {
    // Retired, so the one-active-key rule does not stop a second fixture row for the same tenant.
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO tenant_key (tenant_id, purpose, version, kek_id, dek_wrapped, status)
              VALUES (${tenantId}, 'tenant-dek', ${nextVersion()}, 'test', ${Buffer.from([0])}, 'retired')
              RETURNING id`,
      ),
  },
  location: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO location (tenant_id, name, time_zone)
              VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
              RETURNING id`,
      ),
  },
  professional: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO professional (tenant_id, membership_id, specialties)
              VALUES (${tenantId}, ${overrides?.['membership_id'] ?? (await insertMembership(tx, tenantId, await insertUser(tx)))}, ARRAY['general'])
              RETURNING id`,
      ),
  },
  professional_hours: {
    insert: async (tx, tenantId, overrides) => {
      const professionalId =
        overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId));
      const locationId =
        overrides?.['location_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO location (tenant_id, name, time_zone)
                VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
                RETURNING id`,
        ));
      return returningId(
        tx,
        sql`INSERT INTO professional_hours (tenant_id, professional_id, location_id, weekday, start_minute, end_minute)
              VALUES (${tenantId}, ${professionalId}, ${locationId}, 1, 540, 780)
              RETURNING id`,
      );
    },
  },
  permission_grant: {
    insert: async (tx, tenantId, overrides) => {
      const membershipId =
        overrides?.['membership_id'] ??
        (await insertMembership(tx, tenantId, await insertUser(tx)));
      return returningId(
        tx,
        sql`INSERT INTO permission_grant (tenant_id, membership_id, permission, granted_by)
              VALUES (${tenantId}, ${membershipId}, 'cash.operate', ${randomUUID()})
              RETURNING id`,
      );
    },
  },
  membership_location: {
    insert: async (tx, tenantId, overrides) => {
      const membershipId =
        overrides?.['membership_id'] ??
        (await insertMembership(tx, tenantId, await insertUser(tx)));
      const locationId =
        overrides?.['location_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO location (tenant_id, name, time_zone)
                VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
                RETURNING id`,
        ));
      return returningId(
        tx,
        sql`INSERT INTO membership_location (tenant_id, membership_id, location_id)
              VALUES (${tenantId}, ${membershipId}, ${locationId})
              RETURNING id`,
      );
    },
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

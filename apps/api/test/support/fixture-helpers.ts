import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import type { Tx } from '../../src/platform/db/tenant-context.js';

/**
 * The type of a fixture and the helpers that build the rows a fixture points at (a patient, a
 * professional, a location, an appointment). Every file of `fixtures/` imports from here, so the
 * helpers are written once.
 *
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

export async function returningId(tx: Tx, statement: ReturnType<typeof sql>): Promise<string> {
  const result = await tx.execute<{ id: string }>(statement);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('fixture insert returned no id');
  return id;
}

let versionCounter = 100;
/** Distinct key versions for fixtures (the version is unique per tenant). */
export function nextVersion(): number {
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
 * insert and puts the caller's value back afterwards. The address carries part of the id: the
 * counter restarts in every test file, and files that commit their fixtures share one database.
 */
export async function insertUser(tx: Tx): Promise<string> {
  const id = randomUUID();
  const previous = await tx.execute<{ value: string }>(
    sql`select current_setting('app.user_id') as value`,
  );
  await tx.execute(sql`select set_config('app.user_id', ${id}, true)`);
  await tx.execute(
    sql`INSERT INTO user_account (id, email, password_hash)
          VALUES (${id}, ${unique('fixture') + '-' + id.slice(0, 8) + '@example.test'}, 'hash')`,
  );
  await tx.execute(sql`select set_config('app.user_id', ${previous.rows[0]?.value ?? ''}, true)`);
  return id;
}

export async function insertMembership(tx: Tx, tenantId: string, userId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO membership (tenant_id, user_id, roles)
          VALUES (${tenantId}, ${userId}, ARRAY['reception']) RETURNING id`,
  );
}

export async function insertProfessional(tx: Tx, tenantId: string): Promise<string> {
  const membershipId = await insertMembership(tx, tenantId, await insertUser(tx));
  return returningId(
    tx,
    sql`INSERT INTO professional (tenant_id, membership_id, specialties)
          VALUES (${tenantId}, ${membershipId}, ARRAY['general'])
          RETURNING id`,
  );
}

export async function insertPatient(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO patient (tenant_id, family_name, given_names, birth_date)
          VALUES (${tenantId}, ${unique('Apellido')}, 'Nombre', '1990-01-01')
          RETURNING id`,
  );
}

export async function insertLocation(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO location (tenant_id, name, time_zone)
          VALUES (${tenantId}, ${unique('Location')}, 'America/Argentina/Buenos_Aires')
          RETURNING id`,
  );
}

let appointmentDay = 0;
/** An appointment on a day of its own, so repeated fixtures never overlap. */
export async function insertAppointmentRow(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  appointmentDay += 1;
  return returningId(
    tx,
    sql`INSERT INTO appointment
          (tenant_id, patient_id, professional_id, location_id, appointment_type_id, starts_at, ends_at, booked_by)
          VALUES (${tenantId},
                  ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                  ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))},
                  ${overrides?.['location_id'] ?? (await insertLocation(tx, tenantId))},
                  ${overrides?.['appointment_type_id'] ?? (await returningId(tx, sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes) VALUES (${tenantId}, ${unique('Consulta')}, 30) RETURNING id`))},
                  (timestamptz '2031-01-01T10:00:00Z' + ${appointmentDay}::int * interval '1 day'),
                  (timestamptz '2031-01-01T10:30:00Z' + ${appointmentDay}::int * interval '1 day'),
                  ${randomUUID()})
          RETURNING id`,
  );
}

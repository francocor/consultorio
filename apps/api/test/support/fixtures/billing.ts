import { sql } from 'drizzle-orm';

import {
  insertAppointmentRow,
  insertLocation,
  insertPatient,
  insertProfessional,
  returningId,
  unique,
  type TenantTableFixture,
} from '../fixture-helpers.js';

/**
 * Fixtures of the tables of billing (track A): one valid row per table, for the generated isolation
 * suite. The overrides replace a foreign key with an id of another organization.
 */

type Tx = Parameters<TenantTableFixture['insert']>[0];

async function insertType(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
          VALUES (${tenantId}, ${unique('Consulta')}, 30) RETURNING id`,
  );
}

async function insertTenantPayer(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO tenant_payer (tenant_id, custom_name)
          VALUES (${tenantId}, ${unique('Prepaga')}) RETURNING id`,
  );
}

async function insertCharge(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO charge (tenant_id, appointment_id, patient_id, professional_id, location_id,
                            tenant_payer_id, snapshot, captured_by)
          VALUES (${tenantId},
                  ${overrides?.['appointment_id'] ?? (await insertAppointmentRow(tx, tenantId))},
                  ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                  ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))},
                  ${overrides?.['location_id'] ?? (await insertLocation(tx, tenantId))},
                  ${overrides?.['tenant_payer_id'] ?? null},
                  '{"source":"private"}'::jsonb, gen_random_uuid())
          RETURNING id`,
  );
}

export const fixtures: Record<string, TenantTableFixture> = {
  tenant_payer: { insert: insertTenantPayer },
  charge: { insert: insertCharge },
  charge_line: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO charge_line (tenant_id, charge_id, position, kind, portion, description, amount_cents)
              VALUES (${tenantId}, ${overrides?.['charge_id'] ?? (await insertCharge(tx, tenantId))},
                      1, 'service', 'patient', 'Consulta', 2000000)
              RETURNING id`,
      ),
  },
  price: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO price (tenant_id, appointment_type_id, professional_id, location_id,
                               amount_cents, effective_from)
              VALUES (${tenantId},
                      ${overrides?.['appointment_type_id'] ?? (await insertType(tx, tenantId))},
                      ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))},
                      ${overrides?.['location_id'] ?? (await insertLocation(tx, tenantId))},
                      2000000, '2031-01-01')
              RETURNING id`,
      ),
  },
  payer_plan_price: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO payer_plan_price (tenant_id, tenant_payer_id, appointment_type_id,
                                          payer_amount_cents, copago_cents, effective_from)
              VALUES (${tenantId},
                      ${overrides?.['tenant_payer_id'] ?? (await insertTenantPayer(tx, tenantId))},
                      ${overrides?.['appointment_type_id'] ?? (await insertType(tx, tenantId))},
                      1500000, 300000, '2031-01-01')
              RETURNING id`,
      ),
  },
};

import { randomUUID } from 'node:crypto';

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

async function insertPayment(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO payment (tenant_id, charge_id, location_id, cash_session_id, method, amount_cents,
                             recorded_by, idempotency_key, request_hash, corrects_payment_id)
          VALUES (${tenantId},
                  ${overrides?.['charge_id'] ?? (await insertCharge(tx, tenantId))},
                  ${overrides?.['location_id'] ?? (await insertLocation(tx, tenantId))},
                  ${overrides?.['cash_session_id'] ?? null},
                  'debit', 1000000, gen_random_uuid(), ${randomUUID()}, 'hash',
                  ${overrides?.['corrects_payment_id'] ?? null})
          RETURNING id`,
  );
}

export const fixtures: Record<string, TenantTableFixture> = {
  tenant_payer: { insert: insertTenantPayer },
  charge: { insert: insertCharge },
  cash_session: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO cash_session (tenant_id, location_id, opened_by, opening_cents)
              VALUES (${tenantId},
                      ${overrides?.['location_id'] ?? (await insertLocation(tx, tenantId))},
                      gen_random_uuid(), 500000)
              RETURNING id`,
      ),
  },
  payment: { insert: insertPayment },
  payment_reversal: {
    insert: async (tx, tenantId, overrides) => {
      const paymentId = overrides?.['payment_id'] ?? (await insertPayment(tx, tenantId));
      // A reversal names the charge of its payment (the guard of the database insists on it).
      const paymentsCharge = await tx.execute<{ charge_id: string }>(
        sql`SELECT charge_id FROM payment WHERE id = ${paymentId}`,
      );
      const chargeId =
        overrides?.['charge_id'] ??
        paymentsCharge.rows[0]?.charge_id ??
        (await insertCharge(tx, tenantId));
      return returningId(
        tx,
        sql`INSERT INTO payment_reversal (tenant_id, payment_id, charge_id, location_id, cash_session_id,
                                          amount_cents, reason, kind, reversed_by, idempotency_key,
                                          request_hash)
              VALUES (${tenantId}, ${paymentId},
                      ${chargeId},
                      ${overrides?.['location_id'] ?? (await insertLocation(tx, tenantId))},
                      ${overrides?.['cash_session_id'] ?? null},
                      100, 'Devolución', 'refund', gen_random_uuid(), ${randomUUID()}, 'hash')
              RETURNING id`,
      );
    },
  },
  export_request: {
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO export_request (tenant_id, kind, format, filters, requested_by)
              VALUES (${tenantId}, 'charges', 'csv', '{}'::jsonb, gen_random_uuid())
              RETURNING id`,
      ),
  },
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

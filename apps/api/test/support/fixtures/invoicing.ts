import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { insertPatient, returningId, type TenantTableFixture } from '../fixture-helpers.js';

import { fixtures as billingFixtures } from './billing.js';

/**
 * Fixtures of the tables of invoicing (track C): one valid row per table, for the generated
 * isolation suite. Never a real certificate: the ciphertext columns hold placeholder bytes.
 */

let pointOfSaleNumber = 0;

type Tx = Parameters<TenantTableFixture['insert']>[0];

/**
 * A pending patient invoice. The overrides replace a foreign key with an id of another
 * organization; a credit note is made when `credit_note_of_id` is given (it carries the letter and
 * the reason a credit note needs).
 */
async function insertInvoice(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  const creditNoteOf = overrides?.['credit_note_of_id'] ?? null;
  const payer = overrides?.['tenant_payer_id'] ?? null;
  return returningId(
    tx,
    sql`INSERT INTO invoice (tenant_id, type, point_of_sale, status, delivery_state, issue_date,
                             environment, simulated, idempotency_key, request_hash, recipient_kind,
                             patient_id, tenant_payer_id, recipient_name, recipient_tax_condition,
                             total_cents, net_cents, location_ids, credit_note_of_id, reason,
                             previous_attempt_id, created_by)
          VALUES (${tenantId}, ${creditNoteOf === null ? 'FC' : 'NCC'}, 1, 'pending', 'queued',
                  date '2031-01-02', 'homologation', true, ${randomUUID()}, 'hash',
                  ${payer === null ? 'patient' : 'payer'},
                  ${payer === null ? (overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))) : null},
                  ${payer},
                  'Paciente de prueba', 'consumidor_final', 100, 100, ARRAY[]::uuid[],
                  ${creditNoteOf}, ${creditNoteOf === null ? null : 'Error de carga'},
                  ${overrides?.['previous_attempt_id'] ?? null}, gen_random_uuid())
          RETURNING id`,
  );
}

/** The charge that a charge line belongs to (an invoice line names both). */
async function chargeOfLine(tx: Tx, chargeLineId: string): Promise<string> {
  const result = await tx.execute<{ charge_id: string }>(
    sql`SELECT charge_id FROM charge_line WHERE id = ${chargeLineId}`,
  );
  return result.rows[0]?.charge_id ?? randomUUID();
}

export const fixtures: Record<string, TenantTableFixture> = {
  fiscal_profile: {
    // One row per organization: the suite inserts for the same tenant several times, so the
    // fixture updates the row that is already there (the policy still checks the proposed row).
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO fiscal_profile
              (tenant_id, cuit, tax_condition, business_name, address, activity_started_on)
              VALUES (${tenantId}, '20123456786', 'monotributo', 'Consultorio de prueba',
                      'Calle 1, CABA', '2020-01-01')
              ON CONFLICT (tenant_id) DO UPDATE SET business_name = EXCLUDED.business_name
              RETURNING id`,
      ),
  },
  point_of_sale: {
    insert: (tx, tenantId) => {
      pointOfSaleNumber = (pointOfSaleNumber % 99_000) + 1;
      return returningId(
        tx,
        sql`INSERT INTO point_of_sale (tenant_id, number)
              VALUES (${tenantId}, ${pointOfSaleNumber})
              ON CONFLICT (tenant_id, number) DO UPDATE SET active = true
              RETURNING id`,
      );
    },
  },
  fiscal_credential: {
    // History rows (replaced), so any number of them can exist next to the one active credential.
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO fiscal_credential
              (tenant_id, certificate_enc, private_key_enc, not_before, not_after,
               subject_cuit, fingerprint, active, replaced_at)
              VALUES (${tenantId}, '\\x00'::bytea, '\\x00'::bytea,
                      '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '20123456786',
                      ${randomUUID().replaceAll('-', '').padEnd(64, '0')}, false, now())
              RETURNING id`,
      ),
  },
  invoice: { insert: insertInvoice },
  invoice_line: {
    // A line is written with its invoice (a trigger refuses it later), so the fixture makes both.
    insert: async (tx, tenantId, overrides) => {
      const chargeLineId =
        overrides?.['charge_line_id'] ??
        (await billingFixtures['charge_line']?.insert(tx, tenantId));
      if (chargeLineId === undefined) throw new Error('the billing fixtures have no charge line');
      return returningId(
        tx,
        sql`INSERT INTO invoice_line (tenant_id, invoice_id, charge_line_id, charge_id, position,
                                      description, amount_cents)
              VALUES (${tenantId},
                      ${overrides?.['invoice_id'] ?? (await insertInvoice(tx, tenantId))},
                      ${chargeLineId}, ${await chargeOfLine(tx, chargeLineId)}, 1, 'Consulta', 100)
              RETURNING id`,
      );
    },
  },
  invoice_document: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO invoice_document (tenant_id, invoice_id, object_key, size_bytes)
              VALUES (${tenantId},
                      ${overrides?.['invoice_id'] ?? (await insertInvoice(tx, tenantId))},
                      ${'t/' + tenantId + '/invoices/' + randomUUID() + '.pdf'}, 1024)
              RETURNING id`,
      ),
  },
};

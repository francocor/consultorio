import { randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { insertPatient, returningId, unique, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the portal tables (track B): one valid row per table, for the generated isolation
 * suite. The overrides replace a foreign key with an id of another organization, to prove the
 * composite foreign key refuses it.
 */

type Tx = Parameters<TenantTableFixture['insert']>[0];

async function insertIdentity(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO portal_identity (tenant_id, email, invited_patient_id)
          VALUES (${tenantId}, ${`${unique('portal')}@example.test`},
                  ${overrides?.['invited_patient_id'] ?? null})
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
  // A change to the e-mail of a record (JD-S5 R2-2); the isolation suite points the patient at
  // another organization's row to prove the composite foreign key refuses it.
  patient_record_change: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO patient_record_change (tenant_id, patient_id, email_changed, birth_date_changed)
              VALUES (${tenantId}, ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                      true, false)
              RETURNING id`,
      ),
  },
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
  // A share points at an administrative document and at the patient of that document; the isolation
  // suite points either at another organization's row to prove the composite key refuses it.
  document_share: {
    insert: async (tx, tenantId, overrides) => {
      const patientId = overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId));
      const documentId =
        overrides?.['document_id'] ??
        (await (async () => {
          const id = randomUUID();
          return returningId(
            tx,
            sql`INSERT INTO document (id, tenant_id, patient_id, category, classification, original_name,
                                      declared_content_type, size_bytes, object_key, uploaded_by)
                  VALUES (${id}, ${tenantId}, ${patientId}, 'id_copy', 'administrative', 'dni.pdf',
                          'application/pdf', 1000, ${`t/${tenantId}/quarantine/${id}`}, ${randomUUID()})
                  RETURNING id`,
          );
        })());
      return returningId(
        tx,
        sql`INSERT INTO document_share (tenant_id, document_id, patient_id, shared_by)
              VALUES (${tenantId}, ${documentId}, ${patientId}, ${randomUUID()})
              RETURNING id`,
      );
    },
  },
};

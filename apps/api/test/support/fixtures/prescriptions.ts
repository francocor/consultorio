import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  insertPatient,
  insertProfessional,
  returningId,
  unique,
  type TenantTableFixture,
} from '../fixture-helpers.js';
import { CLINICAL_AUTHORS } from '../fixtures.js';

/**
 * Fixtures of the tables of the prescriptions module (track A3): one valid row per table, for the
 * generated isolation suite. A prescription is clinical, so it is written acting as its author (the
 * database refuses anybody else) and read back as that author; the ciphertext holds placeholder
 * bytes, never a real prescription.
 */
export const fixtures: Record<string, TenantTableFixture> = {
  prescription: {
    insert: async (tx, tenantId, overrides) => {
      const authorId =
        overrides?.['author_professional_id'] ?? (await insertProfessional(tx, tenantId));
      const patientId = overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId));
      await tx.execute(sql`select set_config('app.professional_id', ${authorId}, true)`);
      const id = await returningId(
        tx,
        sql`INSERT INTO prescription (tenant_id, patient_id, author_professional_id, encounter_id,
                                      client_key, content_enc, prescription_date, idempotency_key)
              VALUES (${tenantId}, ${patientId}, ${authorId}, ${overrides?.['encounter_id'] ?? null},
                      ${randomUUID()}, ${Buffer.from([1])}, date '2031-01-02', ${unique('fixture-key') + '-' + randomUUID()})
              RETURNING id`,
      );
      await tx.execute(sql`select set_config('app.professional_id', '', true)`);
      CLINICAL_AUTHORS.set(id, authorId);
      return id;
    },
  },
  erx_connection: {
    // One row per organization: the suite inserts for the same tenant several times, so the
    // fixture updates the row that is already there (the policy still checks the proposed row).
    insert: (tx, tenantId) =>
      returningId(
        tx,
        sql`INSERT INTO erx_connection (tenant_id, provider_key, enabled, status)
              VALUES (${tenantId}, 'local', true, 'active')
              ON CONFLICT (tenant_id) DO UPDATE SET provider_key = excluded.provider_key
              RETURNING id`,
      ),
  },
};

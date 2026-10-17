import { sql } from 'drizzle-orm';

import {
  insertLocation,
  insertPatient,
  insertProfessional,
  returningId,
  unique,
  type TenantTableFixture,
} from '../fixture-helpers.js';

/**
 * Fixtures of the tables of the waitlist (track C): one valid row per table, for the generated
 * isolation suite. The overrides replace a foreign key with an id of another organization.
 */

type Tx = Parameters<TenantTableFixture['insert']>[0];

async function insertType(tx: Tx, tenantId: string): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
          VALUES (${tenantId}, ${unique('Control')}, 30) RETURNING id`,
  );
}

async function insertEntry(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO waitlist_entry
          (tenant_id, patient_id, appointment_type_id, professional_id, location_id, expires_at)
          VALUES (${tenantId},
                  ${overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId))},
                  ${overrides?.['appointment_type_id'] ?? (await insertType(tx, tenantId))},
                  ${overrides?.['professional_id'] ?? null},
                  ${overrides?.['location_id'] ?? null},
                  now() + interval '60 days')
          RETURNING id`,
  );
}

export const fixtures: Record<string, TenantTableFixture> = {
  waitlist_entry: { insert: insertEntry },
  waitlist_offer: {
    insert: async (tx, tenantId, overrides) => {
      const patientId = overrides?.['patient_id'] ?? (await insertPatient(tx, tenantId));
      const entryId =
        overrides?.['entry_id'] ?? (await insertEntry(tx, tenantId, { patient_id: patientId }));
      const professionalId =
        overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId));
      const locationId = overrides?.['location_id'] ?? (await insertLocation(tx, tenantId));
      const typeId = overrides?.['appointment_type_id'] ?? (await insertType(tx, tenantId));
      return returningId(
        tx,
        sql`INSERT INTO waitlist_offer
              (tenant_id, entry_id, patient_id, slot_key, professional_id, location_id,
               appointment_type_id, starts_at, ends_at, freed_starts_at, freed_ends_at,
               send_at, expires_at, appointment_id)
              VALUES (${tenantId}, ${entryId}, ${patientId}, ${unique('slot')},
                      ${professionalId}, ${locationId}, ${typeId},
                      '2031-01-01T10:00:00Z', '2031-01-01T10:30:00Z',
                      '2031-01-01T10:00:00Z', '2031-01-01T10:30:00Z',
                      now(), now() + interval '30 minutes',
                      ${overrides?.['appointment_id'] ?? null})
              RETURNING id`,
      );
    },
  },
};

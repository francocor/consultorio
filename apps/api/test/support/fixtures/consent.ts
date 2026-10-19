import { sql } from 'drizzle-orm';

import { returningId, unique, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the tables of consent (track A2): one valid row per table, for the generated
 * isolation suite. The overrides replace a foreign key with an id of another organization.
 */

type Tx = Parameters<TenantTableFixture['insert']>[0];

const HASH = 'a'.repeat(64);

export async function insertConsentTemplate(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO consent_template (tenant_id, title, draft_body, appointment_type_id, created_by)
          VALUES (${tenantId}, ${unique('Extraccion')}, 'Texto del consentimiento.',
                  ${overrides?.['appointment_type_id'] ?? null}, gen_random_uuid())
          RETURNING id`,
  );
}

export async function insertConsentTemplateVersion(
  tx: Tx,
  tenantId: string,
  overrides?: Readonly<Record<string, string>>,
): Promise<string> {
  return returningId(
    tx,
    sql`INSERT INTO consent_template_version
          (tenant_id, template_id, version_number, title, body, content_hash, published_by)
          VALUES (${tenantId},
                  ${overrides?.['template_id'] ?? (await insertConsentTemplate(tx, tenantId))},
                  1, ${unique('Extraccion')}, 'Texto del consentimiento.', ${HASH}, gen_random_uuid())
          RETURNING id`,
  );
}

export const fixtures: Record<string, TenantTableFixture> = {
  consent_template: { insert: insertConsentTemplate },
  consent_template_version: { insert: insertConsentTemplateVersion },
};

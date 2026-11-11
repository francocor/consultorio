import { sql } from 'drizzle-orm';

import {
  insertConsentRequest,
  insertConsentRevocation,
  insertConsentSignature,
  insertConsentTemplate,
  insertConsentTemplateVersion,
} from '../consent-rows.js';
import { insertProfessional, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the tables of consent (track A2): one valid row per table, for the generated
 * isolation suite. The overrides replace a foreign key with an id of another organization.
 */

export const fixtures: Record<string, TenantTableFixture> = {
  consent_template: { insert: insertConsentTemplate },
  consent_template_version: { insert: insertConsentTemplateVersion },
  consent_request: {
    insert: (tx, tenantId, overrides) => insertConsentRequest(tx, tenantId, overrides),
  },
  consent_signature: {
    // A signature is read by a health professional only (the SELECT policy of migration 0512), so
    // the generic suite reads it as a professional who treats the patient, like the clinical tables.
    // The registry lives in `fixtures.ts`, which imports this file: it is reached lazily to avoid a
    // cycle at load time.
    async insert(tx, tenantId, overrides) {
      const registry = await import('../fixtures.js');
      (registry.CLINICAL_TABLES as Set<string>).add('consent_signature');
      const signed = await insertConsentSignature(tx, tenantId, overrides);
      const professionalId = await insertProfessional(tx, tenantId);
      await tx.execute(
        sql`INSERT INTO care_assignment (tenant_id, patient_id, professional_id, assigned_by)
              VALUES (${tenantId}, ${signed.patientId}, ${professionalId}, gen_random_uuid())`,
      );
      registry.CLINICAL_AUTHORS.set(signed.id, professionalId);
      return signed.id;
    },
  },
  consent_revocation: { insert: insertConsentRevocation },
};

import { sql } from 'drizzle-orm';

import type { Tx } from '../../../platform/db/tenant-context.js';
import type { OnboardingFacts } from '../domain/facts.js';

interface FactsRow extends Record<string, unknown> {
  locations: number;
  professionals: number;
  professionals_with_hours: number;
  appointment_types: number;
  has_patient: boolean;
  has_appointment: boolean;
  professionals_with_matricula: number;
  staff_invited: boolean;
  branding_configured: boolean;
}

/**
 * Counts what the organization has, in one round trip, under the transaction's tenant (row level
 * security does the scoping; nothing here names a tenant). Existence checks stop at the first row,
 * so a large practice pays nothing for "has any patient".
 */
export async function readFacts(tx: Tx): Promise<OnboardingFacts> {
  const result = await tx.execute<FactsRow>(sql`
    SELECT
      (SELECT count(*) FROM location WHERE active)::int AS locations,
      (SELECT count(*) FROM professional WHERE status = 'active')::int AS professionals,
      (SELECT count(*)
         FROM professional p
        WHERE p.status = 'active'
          AND EXISTS (
            SELECT 1
              FROM professional_hours h
              JOIN location l ON l.tenant_id = h.tenant_id AND l.id = h.location_id AND l.active
             WHERE h.tenant_id = p.tenant_id AND h.professional_id = p.id AND h.removed_at IS NULL
          ))::int AS professionals_with_hours,
      (SELECT count(*) FROM appointment_type WHERE active)::int AS appointment_types,
      EXISTS (SELECT 1 FROM patient) AS has_patient,
      EXISTS (SELECT 1 FROM appointment) AS has_appointment,
      (SELECT count(*) FROM professional WHERE status = 'active' AND matricula IS NOT NULL)::int
        AS professionals_with_matricula,
      (EXISTS (
         SELECT 1 FROM action_token
          WHERE kind = 'staff_invitation' AND coalesce(payload ->> 'origin', '') <> 'operator'
       ) OR (SELECT count(*) FROM membership) > 1) AS staff_invited,
      coalesce((SELECT theme ? 'primaryRequested' OR theme ? 'logo' FROM tenant), false)
        AS branding_configured
  `);
  const row = result.rows[0];
  if (!row) throw new Error('onboarding facts returned no row');
  return {
    locations: row.locations,
    professionals: row.professionals,
    professionalsWithHours: row.professionals_with_hours,
    appointmentTypes: row.appointment_types,
    patients: row.has_patient ? 1 : 0,
    appointments: row.has_appointment ? 1 : 0,
    professionalsWithMatricula: row.professionals_with_matricula,
    staffInvited: row.staff_invited,
    brandingConfigured: row.branding_configured,
  };
}

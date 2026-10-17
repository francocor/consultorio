import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { insertProfessional, returningId, type TenantTableFixture } from '../fixture-helpers.js';

/**
 * Fixtures of the online-booking tables (track B). A booking link is one per professional, so each
 * fixture creates its own professional unless the isolation suite points the link at another
 * organization's professional to prove the foreign key refuses it.
 */
export const fixtures: Record<string, TenantTableFixture> = {
  booking_link: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO booking_link (tenant_id, professional_id, slug)
              VALUES (${tenantId},
                      ${overrides?.['professional_id'] ?? (await insertProfessional(tx, tenantId))},
                      ${randomBytes(8).toString('hex')})
              RETURNING id`,
      ),
  },
};

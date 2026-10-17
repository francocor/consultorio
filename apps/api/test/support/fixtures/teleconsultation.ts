import { sql } from 'drizzle-orm';

import { insertAppointmentRow, returningId, type TenantTableFixture } from '../fixture-helpers.js';

/** Fixtures of the tables of the teleconsultation module (see `fixtures/tenant-state.ts`). */
export const fixtures: Record<string, TenantTableFixture> = {
  video_session: {
    insert: async (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO video_session (tenant_id, appointment_id, status, pending_reason)
              VALUES (${tenantId},
                      ${overrides?.['appointment_id'] ?? (await insertAppointmentRow(tx, tenantId))},
                      'link_pending', 'creating')
              RETURNING id`,
      ),
  },
};

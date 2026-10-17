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
  // A booking points at its hold; the isolation suite points that column at another organization's
  // row to prove the foreign key refuses it, so the fixture makes a booking only then.
  booking_submission: {
    insert: (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO booking_submission
              (tenant_id, kind, email, payload_enc, hold_id, appointment_id, purge_after)
              VALUES (${tenantId},
                      ${overrides?.['hold_id'] === undefined ? 'waitlist_join' : 'booking'},
                      ${`${randomBytes(6).toString('hex')}@example.test`},
                      ${Buffer.from([1])},
                      ${overrides?.['hold_id'] ?? null},
                      ${overrides?.['appointment_id'] ?? null},
                      now() + interval '24 hours')
              RETURNING id`,
      ),
  },
  otp_challenge: {
    insert: (tx, tenantId, overrides) =>
      returningId(
        tx,
        sql`INSERT INTO otp_challenge (tenant_id, purpose, email, submission_id, expires_at)
              VALUES (${tenantId}, 'booking',
                      ${`${randomBytes(6).toString('hex')}@example.test`},
                      ${overrides?.['submission_id'] ?? null},
                      now() + interval '10 minutes')
              RETURNING id`,
      ),
  },
};

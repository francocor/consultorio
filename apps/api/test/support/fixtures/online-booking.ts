import { randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import {
  insertLocation,
  insertProfessional,
  returningId,
  unique,
  type TenantTableFixture,
} from '../fixture-helpers.js';

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
  // What a public hold was made for: the hold, the type of visit and the link it came through.
  public_hold: {
    insert: async (tx, tenantId, overrides) => {
      const holdId =
        overrides?.['hold_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO slot_hold
                (tenant_id, professional_id, location_id, starts_at, ends_at, expires_at, source_key, status, origin)
                VALUES (${tenantId}, ${await insertProfessional(tx, tenantId)},
                        ${await insertLocation(tx, tenantId)},
                        '2031-01-01T10:00:00Z', '2031-01-01T10:30:00Z',
                        now() + interval '10 minutes', ${randomBytes(8).toString('hex')},
                        'expired', 'public')
                RETURNING id`,
        ));
      const typeId =
        overrides?.['appointment_type_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO appointment_type (tenant_id, name, duration_minutes)
                VALUES (${tenantId}, ${unique('Consulta')}, 30) RETURNING id`,
        ));
      const linkId =
        overrides?.['booking_link_id'] ??
        (await returningId(
          tx,
          sql`INSERT INTO booking_link (tenant_id, professional_id, slug)
                VALUES (${tenantId}, ${await insertProfessional(tx, tenantId)},
                        ${randomBytes(8).toString('hex')})
                RETURNING id`,
        ));
      return returningId(
        tx,
        sql`INSERT INTO public_hold (tenant_id, hold_id, appointment_type_id, booking_link_id)
              VALUES (${tenantId}, ${holdId}, ${typeId}, ${linkId}) RETURNING id`,
      );
    },
  },
};

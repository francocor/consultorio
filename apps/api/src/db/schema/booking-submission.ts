import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea, citext, tenantTable } from './_helpers.js';
import { appointment, slotHold } from './scheduling.js';
import { tenant } from './tenant.js';

export const SUBMISSION_KINDS = ['booking', 'waitlist_join'] as const;
export const OTP_PURPOSES = [
  'booking',
  'waitlist_join',
  'portal_registration',
  'portal_sign_in',
] as const;

const KINDS_SQL = `('${SUBMISSION_KINDS.join("', '")}')`;
const PURPOSES_SQL = `('${OTP_PURPOSES.join("', '")}')`;

/**
 * What a visitor typed into the public form, kept until they prove they control the email address
 * (online-booking, "Privacy and data minimization"). It is NOT a patient and NOT an appointment:
 * nothing patient-shaped exists before the code is verified.
 *
 * - `payload_enc` holds the form (names, document, phone, reason, consents) encrypted with the
 *   organization's data key, so a dump of the database does not read it. The email is a column of
 *   its own: the code goes only there, and the limits per address count it.
 * - An `unverified` row is hard-deleted by `booking.purge` once `purge_after` has passed (retention
 *   exception 4 of the no-delete rule). A `verified` row is never touched by the purge; when the
 *   booking is confirmed its payload is cut down to the consent evidence.
 * - A booking submission points at the slot hold it was made for, one submission per hold.
 */
export const bookingSubmission = tenantTable(
  'booking_submission',
  {
    kind: text('kind').notNull(),
    status: text('status').notNull().default('unverified'),
    email: citext('email').notNull(),
    payloadEnc: bytea('payload_enc').notNull(),
    holdId: uuid('hold_id'),
    purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /** The appointment a verified booking became. */
    appointmentId: uuid('appointment_id'),
  },
  (table) => [
    foreignKey({
      name: 'booking_submission_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'booking_submission_hold_fkey',
      columns: [table.tenantId, table.holdId],
      foreignColumns: [slotHold.tenantId, slotHold.id],
    }),
    foreignKey({
      name: 'booking_submission_appointment_fkey',
      columns: [table.tenantId, table.appointmentId],
      foreignColumns: [appointment.tenantId, appointment.id],
    }),
    check('booking_submission_kind_check', sql`${table.kind} in ${sql.raw(KINDS_SQL)}`),
    check('booking_submission_status_check', sql`${table.status} in ('unverified', 'verified')`),
    check(
      'booking_submission_verified_check',
      sql`(${table.status} = 'verified') = (${table.verifiedAt} is not null)`,
    ),
    // A booking is for a slot; a waitlist join has none.
    check(
      'booking_submission_hold_check',
      sql`(${table.kind} = 'booking') = (${table.holdId} is not null)`,
    ),
    uniqueIndex('booking_submission_hold_key')
      .on(table.tenantId, table.holdId)
      .where(sql`${table.holdId} is not null`),
    index('booking_submission_purge_idx')
      .on(table.purgeAfter)
      .where(sql`${table.status} = 'unverified'`),
    index('booking_submission_email_idx').on(table.tenantId, table.email, table.createdAt),
  ],
);

export type BookingSubmissionRow = typeof bookingSubmission.$inferSelect;

/**
 * One one-time code sent by email: 6 digits, ten minutes, five wrong attempts (online-booking,
 * "Abuse protection"). Every send is a row of its own, so "at most 3 sends per email per hour" is a
 * count of rows. The code itself is never stored: the hash is written by the job that emails it,
 * which is the only place the code exists in clear.
 *
 * It serves the booking and the waitlist self-join now, and the patient portal later (the other
 * purposes), with the same limits.
 */
export const otpChallenge = tenantTable(
  'otp_challenge',
  {
    purpose: text('purpose').notNull(),
    email: citext('email').notNull(),
    submissionId: uuid('submission_id'),
    /** Null until the job generated the code; a challenge without a hash accepts nothing. */
    codeHash: text('code_hash'),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when the code was used, or when five wrong attempts spent it. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'otp_challenge_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenant.id],
    }),
    foreignKey({
      name: 'otp_challenge_submission_fkey',
      columns: [table.tenantId, table.submissionId],
      foreignColumns: [bookingSubmission.tenantId, bookingSubmission.id],
    }),
    check('otp_challenge_purpose_check', sql`${table.purpose} in ${sql.raw(PURPOSES_SQL)}`),
    check('otp_challenge_attempts_check', sql`${table.attempts} >= 0`),
    index('otp_challenge_email_idx').on(table.tenantId, table.email, table.createdAt),
    index('otp_challenge_submission_idx').on(table.tenantId, table.submissionId),
    index('otp_challenge_expiry_idx').on(table.expiresAt),
  ],
);

export type OtpChallengeRow = typeof otpChallenge.$inferSelect;

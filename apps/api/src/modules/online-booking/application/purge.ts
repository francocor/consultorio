import { and, eq, inArray, lte } from 'drizzle-orm';

import { bookingSubmission, otpChallenge } from '../../../db/schema/booking-submission.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';

export const BOOKING_PURGE_JOB = 'booking.purge';

/**
 * Hard-deletes what a visitor typed and never verified (retention exception 4 of the no-delete
 * rule): the unverified submissions whose time is up, the codes that went with them and every
 * code that expired more than an hour ago. A verified submission is never touched, and no patient or appointment exists
 * for what is deleted, because none was created before the code was verified.
 */
export async function purgeAbandoned(
  tx: Tx,
  input: { now: Date },
): Promise<{ submissions: number; codes: number }> {
  const abandoned = await tx
    .select({ id: bookingSubmission.id })
    .from(bookingSubmission)
    .where(
      and(eq(bookingSubmission.status, 'unverified'), lte(bookingSubmission.purgeAfter, input.now)),
    );
  const ids = abandoned.map((row) => row.id);

  // The codes first: they point at the submissions. A code is kept for an hour after it expired,
  // because the limit of three sends an hour per address is counted on these rows.
  const expired = await tx
    .delete(otpChallenge)
    .where(lte(otpChallenge.expiresAt, new Date(input.now.getTime() - 3_600_000)))
    .returning({ id: otpChallenge.id });
  const withSubmissions =
    ids.length === 0
      ? []
      : await tx
          .delete(otpChallenge)
          .where(inArray(otpChallenge.submissionId, ids))
          .returning({ id: otpChallenge.id });
  if (ids.length > 0) {
    await tx.delete(bookingSubmission).where(inArray(bookingSubmission.id, ids));
  }
  return { submissions: ids.length, codes: expired.length + withSubmissions.length };
}

/** The hourly job of every organization. */
export function createBookingPurgeJob(deps: { clock?: () => Date } = {}) {
  const clock = deps.clock ?? (() => new Date());
  return defineJob({
    name: BOOKING_PURGE_JOB,
    // A housekeeping write: in a read-only organization it waits (the purge is by age, so nothing
    // is lost) and the public pages are closed meanwhile.
    category: 'write',
    payload: JobPayload,
    handler: async ({ tx }) => {
      await purgeAbandoned(tx, { now: clock() });
    },
  });
}

import { and, eq, lte, sql } from 'drizzle-orm';

import { slotHold } from '../../../db/schema/scheduling.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';

export const HOLD_EXPIRE_JOB = 'hold.expire';

/**
 * Ends the holds that ran out. Expiry is also applied lazily, under the professional's row lock,
 * whenever someone books, so this job only keeps the table honest. An expired hold simply makes
 * the range visible again: it is NOT a waitlist trigger (waitlist offers come from a cancellation,
 * a move away or a removed block) and nobody is told. Idempotent: it only touches active holds
 * that are past their time, so a redelivery repeats it harmlessly.
 */
export const holdExpireJob = defineJob({
  name: HOLD_EXPIRE_JOB,
  // A housekeeping write: a read-only organization cannot make holds, so nothing is lost by
  // leaving its (already inert) holds for the lazy expiry when it becomes active again.
  category: 'write',
  payload: JobPayload,
  handler: async ({ tx }) => {
    await tx
      .update(slotHold)
      .set({ status: 'expired' })
      .where(and(eq(slotHold.status, 'active'), lte(slotHold.expiresAt, sql`now()`)));
  },
});

import { desc, eq, sql } from 'drizzle-orm';

import { otpChallenge } from '../../../db/schema/booking-submission.js';
import { realSendsInLastHour } from '../../../platform/db/otp-sends.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import {
  CODE_ATTEMPTS,
  CODE_LIFETIME_MS,
  CODE_SENDS_PER_HOUR,
  codeMatches,
} from '../domain/otp.js';

export const OTP_SEND_JOB = 'otp.send';

/** How many codes were sent to an address in the last hour (every purpose counts, a decoy does not). */
export function sendsInLastHour(tx: Tx, email: string, now: Date): Promise<number> {
  return realSendsInLastHour(tx, email, now);
}

export type IssueOutcome =
  { limited: false; challengeId: string; expiresAt: Date } | { limited: true };

/**
 * Opens a challenge for an address and queues the job that emails the code, in the same
 * transaction: both exist or neither does. An address that already had three codes this hour gets
 * nothing. The code itself does not exist yet; the job generates it, hashes it and sends it.
 */
export async function issueChallenge(
  tx: Tx,
  input: {
    tenantId: string;
    purpose: 'booking' | 'waitlist_join';
    email: string;
    submissionId: string;
    now: Date;
    jobs: JobClient;
  },
): Promise<IssueOutcome> {
  if ((await sendsInLastHour(tx, input.email, input.now)) >= CODE_SENDS_PER_HOUR) {
    return { limited: true };
  }
  const expiresAt = new Date(input.now.getTime() + CODE_LIFETIME_MS);
  const [row] = await tx
    .insert(otpChallenge)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      purpose: input.purpose,
      email: input.email,
      submissionId: input.submissionId,
      expiresAt,
      // The clock of the application, not the database's, decides how old a challenge is.
      createdAt: input.now,
    })
    .returning({ id: otpChallenge.id });
  if (!row) throw new Error('otp challenge insert returned no row');
  await input.jobs.enqueue(tx, OTP_SEND_JOB, { tenantId: input.tenantId, challengeId: row.id });
  return { limited: false, challengeId: row.id, expiresAt };
}

/**
 * Checks the code of a submission. Only the newest challenge counts (asking for a new code ends the
 * old one). A wrong code adds an attempt; the fifth spends the challenge; the right code spends it
 * too. It answers instead of throwing, so the attempts it records are committed with the request.
 */
export async function verifyCode(
  tx: Tx,
  input: { submissionId: string; code: string; now: Date },
): Promise<'ok' | 'invalid'> {
  const [challenge] = await tx
    .select()
    .from(otpChallenge)
    .where(eq(otpChallenge.submissionId, input.submissionId))
    .orderBy(desc(otpChallenge.createdAt), desc(otpChallenge.id))
    .limit(1)
    .for('update');
  if (!challenge || challenge.consumedAt !== null) return 'invalid';
  if (challenge.expiresAt.getTime() <= input.now.getTime()) return 'invalid';
  if (challenge.attempts >= CODE_ATTEMPTS) return 'invalid';

  if (codeMatches(challenge.id, input.code, challenge.codeHash)) {
    await tx
      .update(otpChallenge)
      .set({ consumedAt: input.now })
      .where(eq(otpChallenge.id, challenge.id));
    return 'ok';
  }
  const attempts = challenge.attempts + 1;
  await tx
    .update(otpChallenge)
    .set({ attempts, ...(attempts >= CODE_ATTEMPTS ? { consumedAt: input.now } : {}) })
    .where(eq(otpChallenge.id, challenge.id));
  return 'invalid';
}

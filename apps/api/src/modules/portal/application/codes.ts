import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { otpChallenge } from '../../../db/schema/booking-submission.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import {
  PORTAL_CODE_ATTEMPTS,
  PORTAL_CODE_LIFETIME_MS,
  PORTAL_CODE_SENDS_PER_HOUR,
  codeMatches,
} from '../domain/code.js';

export const PORTAL_CODE_JOB = 'portal.code_send';

export type PortalCodePurpose = 'portal_registration' | 'portal_sign_in';

/** How many codes were sent to an address in the last hour (every purpose counts). */
export async function sendsInLastHour(tx: Tx, email: string, now: Date): Promise<number> {
  const rows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.email, email),
        gt(otpChallenge.createdAt, new Date(now.getTime() - 3_600_000)),
      ),
    );
  return rows[0]?.n ?? 0;
}

/**
 * Opens a challenge for an address and queues the job that emails the code, in the same
 * transaction: both exist or neither does. An address that already had three codes this hour gets
 * nothing. The code itself does not exist yet; the job generates it, hashes it and sends it. The
 * live codes of the same address and purpose end: there is one live code per account.
 */
export async function openChallenge(
  tx: Tx,
  input: {
    tenantId: string;
    purpose: PortalCodePurpose;
    email: string;
    now: Date;
    jobs: JobClient;
  },
): Promise<'queued' | 'limited'> {
  if ((await sendsInLastHour(tx, input.email, input.now)) >= PORTAL_CODE_SENDS_PER_HOUR) {
    return 'limited';
  }
  await tx
    .update(otpChallenge)
    .set({ consumedAt: input.now })
    .where(
      and(
        eq(otpChallenge.email, input.email),
        eq(otpChallenge.purpose, input.purpose),
        isNull(otpChallenge.consumedAt),
        gt(otpChallenge.expiresAt, input.now),
      ),
    );
  const [row] = await tx
    .insert(otpChallenge)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      purpose: input.purpose,
      email: input.email,
      expiresAt: new Date(input.now.getTime() + PORTAL_CODE_LIFETIME_MS),
      // The clock of the application, not the database's, decides how old a challenge is.
      createdAt: input.now,
    })
    .returning({ id: otpChallenge.id });
  if (!row) throw new Error('otp challenge insert returned no row');
  await input.jobs.enqueue(tx, PORTAL_CODE_JOB, {
    tenantId: input.tenantId,
    challengeId: row.id,
  });
  return 'queued';
}

/**
 * Checks the code of an address. Only the newest challenge of the purpose counts (asking for a new
 * code ends the old one). A wrong code adds an attempt; the fifth spends the challenge; the right
 * code spends it too. It answers instead of throwing, so the attempts it records are committed with
 * the request.
 */
export async function checkCode(
  tx: Tx,
  input: { purpose: PortalCodePurpose; email: string; code: string; now: Date },
): Promise<'ok' | 'invalid'> {
  const [challenge] = await tx
    .select()
    .from(otpChallenge)
    .where(and(eq(otpChallenge.email, input.email), eq(otpChallenge.purpose, input.purpose)))
    .orderBy(desc(otpChallenge.createdAt), desc(otpChallenge.id))
    .limit(1)
    .for('update');
  if (!challenge || challenge.consumedAt !== null) return 'invalid';
  if (challenge.expiresAt.getTime() <= input.now.getTime()) return 'invalid';
  if (challenge.attempts >= PORTAL_CODE_ATTEMPTS) return 'invalid';

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
    .set({ attempts, ...(attempts >= PORTAL_CODE_ATTEMPTS ? { consumedAt: input.now } : {}) })
    .where(eq(otpChallenge.id, challenge.id));
  return 'invalid';
}

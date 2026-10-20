import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';

import { otpChallenge } from '../../../db/schema/booking-submission.js';
import {
  DECOY_PURPOSE,
  decoysInLastHour,
  realSendsInLastHour,
} from '../../../platform/db/otp-sends.js';
import type { Tx } from '../../../platform/db/tenant-context.js';
import type { RateLimitStore } from '../../../platform/http/rate-limit.js';
import type { JobClient } from '../../../platform/jobs/boss.js';
import {
  PORTAL_CODE_ATTEMPTS,
  PORTAL_CODE_ATTEMPTS_PER_CHALLENGE,
  PORTAL_CODE_LIFETIME_MS,
  PORTAL_CODE_SENDS_PER_HOUR,
  PORTAL_DECOYS_PER_HOUR,
  challengeTriesKey,
  codeMatches,
} from '../domain/code.js';

export const PORTAL_CODE_JOB = 'portal.code_send';

export type PortalCodePurpose = 'portal_registration' | 'portal_sign_in';

/**
 * How many codes were sent to an address in the last hour (every purpose that sends a code counts; a
 * decoy sends nothing and counts for nothing, JD-S5 R2-1). The one count of the booking and the
 * waitlist too (`realSendsInLastHour`).
 */
export const sendsInLastHour = realSendsInLastHour;

/**
 * Opens a challenge for an address and queues the job that emails the code, in the same
 * transaction: both exist or neither does. An address that already had three codes this hour gets
 * nothing. The code itself does not exist yet; the job generates it, hashes it and sends it. The
 * live codes of the same address and purpose end: there is one live code per account.
 *
 * A `decoy` does the same work for an address that must not receive a code, so the answer of the
 * route takes the same time whether or not the address has an account (JD-S5 R1-A-T3): the challenge
 * is written already spent (the job finds nothing to send), with a purpose of its own so that it ends
 * no live code of anybody and counts among no one's sends (JD-S5 R2-1). The hourly purge of the
 * booking removes it an hour after it expired, like any challenge.
 */
export async function openChallenge(
  tx: Tx,
  input: {
    tenantId: string;
    purpose: PortalCodePurpose;
    email: string;
    now: Date;
    jobs: JobClient;
    decoy?: boolean;
  },
): Promise<'queued' | 'limited'> {
  const live = and(
    eq(otpChallenge.email, input.email),
    eq(otpChallenge.purpose, input.purpose),
    isNull(otpChallenge.consumedAt),
    gt(otpChallenge.expiresAt, input.now),
  );
  if (input.decoy === true) {
    // The same lookup, without touching what belongs to the address.
    await tx.select({ id: otpChallenge.id }).from(otpChallenge).where(live);
    // A decoy has a cap of its own, counted among decoys only (JD-S5 R3-1). Above it the caller
    // answers the same as always, but nothing is written and no job is queued.
    if ((await decoysInLastHour(tx, input.email, input.now)) >= PORTAL_DECOYS_PER_HOUR) {
      return 'limited';
    }
  } else {
    if ((await sendsInLastHour(tx, input.email, input.now)) >= PORTAL_CODE_SENDS_PER_HOUR) {
      return 'limited';
    }
    await tx.update(otpChallenge).set({ consumedAt: input.now }).where(live);
  }
  const [row] = await tx
    .insert(otpChallenge)
    .values({
      tenantId: sql`current_setting('app.tenant_id')::uuid`,
      purpose: input.decoy === true ? DECOY_PURPOSE : input.purpose,
      email: input.email,
      expiresAt: new Date(input.now.getTime() + PORTAL_CODE_LIFETIME_MS),
      // The clock of the application, not the database's, decides how old a challenge is.
      createdAt: input.now,
      ...(input.decoy === true ? { consumedAt: input.now } : {}),
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
 * code ends the old one). The tries are counted per challenge and per client (JD-S5 R2-4): a client
 * has five, and then it gets nothing from this code, right or wrong; twenty wrong tries from all
 * clients together spend the challenge, and the right code spends it too. The per-client count lives
 * in the counter store (best effort: a store that fails does not close the portal, and the cap on
 * the challenge still stands). It answers instead of throwing, so the attempts it records are
 * committed with the request.
 */
export async function checkCode(
  tx: Tx,
  input: {
    purpose: PortalCodePurpose;
    email: string;
    code: string;
    now: Date;
    /** Who is trying and where their tries are counted. */
    client: { ip: string | null; userAgent?: string | null; store: RateLimitStore };
  },
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
  if (challenge.attempts >= PORTAL_CODE_ATTEMPTS_PER_CHALLENGE) return 'invalid';
  if (!(await clientHasTries(input.client, challenge.id))) return 'invalid';

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
    .set({
      attempts,
      ...(attempts >= PORTAL_CODE_ATTEMPTS_PER_CHALLENGE ? { consumedAt: input.now } : {}),
    })
    .where(eq(otpChallenge.id, challenge.id));
  return 'invalid';
}

/** Counts one try of this client at this challenge, and says whether it is still within its five. */
async function clientHasTries(
  client: { ip: string | null; userAgent?: string | null; store: RateLimitStore },
  challengeId: string,
): Promise<boolean> {
  try {
    const state = await client.store.hit(
      `portal|code|${challengeTriesKey(challengeId, client.ip, client.userAgent)}`,
      PORTAL_CODE_LIFETIME_MS,
    );
    return state.count <= PORTAL_CODE_ATTEMPTS;
  } catch {
    return true;
  }
}

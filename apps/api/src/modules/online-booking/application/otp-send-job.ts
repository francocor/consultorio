import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { otpChallenge } from '../../../db/schema/booking-submission.js';
import { tenant } from '../../../db/schema/tenant.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { CODE_LIFETIME_MS, generateCode, hashCode } from '../domain/otp.js';

import { renderBookingCodeEmail } from './otp-email.js';
import { OTP_SEND_JOB } from './otp.js';

const OtpSendPayload = JobPayload.extend({ challengeId: z.uuid() });

/**
 * Generates the code of a challenge and emails it to the address of the challenge, and to no one
 * else. The code exists in clear only here: the row gets its hash, the email gets the digits. If the
 * email cannot be sent the transaction rolls back, so a retry draws a fresh code; a challenge that
 * is spent or past its time is left alone. The job is classified `write`, so a read-only
 * organization sends no codes (its public pages are closed anyway).
 */
export function createOtpSendJob(deps: { email: EmailSender; clock?: () => Date }) {
  const clock = deps.clock ?? (() => new Date());
  return defineJob({
    name: OTP_SEND_JOB,
    category: 'write',
    payload: OtpSendPayload,
    handler: async ({ tx, tenantId, payload }) => {
      const now = clock();
      const [challenge] = await tx
        .select()
        .from(otpChallenge)
        .where(and(eq(otpChallenge.id, payload.challengeId), isNull(otpChallenge.consumedAt)))
        .for('update');
      if (!challenge || challenge.expiresAt.getTime() <= now.getTime()) return;

      const code = generateCode();
      await tx
        .update(otpChallenge)
        .set({ codeHash: hashCode(challenge.id, code) })
        .where(eq(otpChallenge.id, challenge.id));

      const [owner] = await tx.select({ isDemo: tenant.isDemo }).from(tenant);
      const rendered = renderBookingCodeEmail({
        organizationName: await readOrganizationName(tx),
        code,
        expiresInMinutes: CODE_LIFETIME_MS / 60_000,
      });
      await deps.email.send({
        to: challenge.email,
        tenant: { id: tenantId, isDemo: owner?.isDemo ?? false },
        ...rendered,
      });
    },
  });
}

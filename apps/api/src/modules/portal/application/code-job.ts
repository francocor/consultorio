import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { otpChallenge } from '../../../db/schema/booking-submission.js';
import { tenant } from '../../../db/schema/tenant.js';
import { JobPayload } from '../../../platform/jobs/boss.js';
import { defineJob } from '../../../platform/jobs/define-job.js';
import type { EmailSender } from '../../../platform/mail/email-sender.js';
import { readOrganizationName } from '../../tenancy/index.js';
import { PORTAL_CODE_LIFETIME_MS, generateCode, hashCode } from '../domain/code.js';

import { PORTAL_CODE_JOB } from './codes.js';
import { renderPortalCodeEmail } from './mail.js';

const CodeSendPayload = JobPayload.extend({ challengeId: z.uuid() });

/**
 * Generates the code of a challenge and emails it to the address of the challenge, and to no one
 * else (portal notice: email only, tagged with the organization so a demo organization's codes
 * never reach the real provider). The code exists in clear only here: the row gets its hash, the
 * email gets the digits. If the email cannot be sent the transaction rolls back, so a retry draws a
 * fresh code; a challenge that is spent or past its time is left alone.
 *
 * The queue is classified `auth`: signing in to the portal keeps working in a read-only
 * organization, so its codes keep being sent.
 */
export function createPortalCodeSendJob(deps: { email: EmailSender; clock?: () => Date }) {
  const clock = deps.clock ?? (() => new Date());
  return defineJob({
    name: PORTAL_CODE_JOB,
    category: 'auth',
    payload: CodeSendPayload,
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
      await deps.email.send({
        to: challenge.email,
        tenant: { id: tenantId, isDemo: owner?.isDemo ?? false },
        ...renderPortalCodeEmail({
          organizationName: await readOrganizationName(tx),
          code,
          expiresInMinutes: PORTAL_CODE_LIFETIME_MS / 60_000,
          registration: challenge.purpose === 'portal_registration',
        }),
      });
    },
  });
}
